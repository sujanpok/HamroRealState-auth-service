pipeline {
    agent any
    
    triggers {
        githubPush()
    }

    environment {
        // Docker Hub
        DOCKER_HUB = credentials('docker-hub-credentials')

        KUBECONFIG = '/var/lib/jenkins/k3s.yaml'

        // App configs
        APP_NAME   = 'auth-service'
        APP_DIR    = "${WORKSPACE}"
        PORT       = '80'  // Service port (external for LoadBalancer)
        APP_PORT   = '3001'  // Pod/container port where app listens

        // Environment variables (adapt from your config.js/db.js)
        NODE_ENV   = 'production'
        DB_HOST    = 'postgres'
        DB_PORT    = '5432'

        // k3s and Helm configs
        HELM_CHART_PATH = './helm'  // Path to your Helm chart
        K3S_NAMESPACE   = 'default'  // Or your preferred namespace
        SERVICE_NAME    = 'auth-service'  // Fixed service name for traffic switching

        // Blue-Green specific
        BLUE_LABEL = 'blue'
        GREEN_LABEL = 'green'

        // Docker image
        DOCKER_IMAGE = "${DOCKER_HUB_USR}/${APP_NAME}"
        DOCKER_TAG   = "${env.BUILD_NUMBER}"  // Unique tag for each build
    }

    stages {
        stage('🔔 Auto-Triggered Build') {
            steps {
                script {
                    echo "🚀 Build triggered automatically by GitHub push!"
                    echo "📝 Commit: ${env.GIT_COMMIT}"
                    echo "🌿 Branch: ${env.GIT_BRANCH}"
                    echo "👤 Author: ${env.CHANGE_AUTHOR ?: 'N/A'}"
                }
            }
        }

        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Initialize Blue-Green') {
            steps {
                script {
                    echo "🔍 Detecting current active color..."
                    // Detect current active color (default to blue if not found)
                    env.CURRENT_ACTIVE = sh(script: "kubectl get svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} -o jsonpath='{.spec.selector.color}' || echo '${BLUE_LABEL}'", returnStdout: true).trim()
                    env.NEW_COLOR = (env.CURRENT_ACTIVE == BLUE_LABEL) ? GREEN_LABEL : BLUE_LABEL
                    env.NEW_RELEASE = "auth-service-${NEW_COLOR}"
                    env.OLD_RELEASE = "auth-service-${(NEW_COLOR == BLUE_LABEL ? GREEN_LABEL : BLUE_LABEL)}"
                    echo "Current active: ${env.CURRENT_ACTIVE} | Deploying to: ${env.NEW_COLOR} (release: ${env.NEW_RELEASE})"
                }
            }
        }

        stage('Generate values.yaml overrides') {
            steps {
                dir("${APP_DIR}") {
                    sh '''
                        echo "📝 Generating Helm values overrides..."
                        cat > helm/values-override.yaml <<EOF
image:
  repository: ${DOCKER_IMAGE}
  tag: ${DOCKER_TAG}
env:
  NODE_ENV: ${NODE_ENV}
  DB_HOST: ${DB_HOST}
  DB_PORT: ${DB_PORT}
imagePullSecrets:
  - name: docker-hub-credentials
EOF
                        echo "✅ values-override.yaml generated!"
                        cat helm/values-override.yaml
                    '''
                }
            }
        }

        stage('Docker Login') {
            steps {
                sh '''
                    echo "${DOCKER_HUB_PSW}" | docker login -u "${DOCKER_HUB_USR}" --password-stdin
                '''
            }
        }

        stage('Build & Push') {
            steps {
                dir("${APP_DIR}") {
                    sh '''
                        echo "🏗️ Building from latest commit (ARM64 for Raspberry Pi)..."
                        docker buildx create --use || true
                        docker buildx build -t ${DOCKER_IMAGE}:${DOCKER_TAG} -t ${DOCKER_IMAGE}:latest --push .
                    '''
                }
            }
        }

        stage('Create Image Pull Secret') {
            steps {
                script {
                    // Create or update the docker-registry secret for image pulls
                    sh """
                        kubectl create secret docker-registry docker-hub-credentials \
                            --docker-server=https://index.docker.io/v1/ \
                            --docker-username="${DOCKER_HUB_USR}" \
                            --docker-password="${DOCKER_HUB_PSW}" \
                            -n ${K3S_NAMESPACE} \
                            --dry-run=client -o yaml | kubectl apply -f -
                    """
                }
            }
        }

        stage('Blue-Green Deploy to k3s') {
            steps {
                withCredentials([
                    string(credentialsId: 'auth-jwt-secret', variable: 'JWT_SECRET'),
                    string(credentialsId: 'auth-db-password', variable: 'DB_PASSWORD'),
                    string(credentialsId: 'auth-database-url', variable: 'DATABASE_URL'),
                    string(credentialsId: 'auth-client-secret', variable: 'CLIENT_SECRET')
                ]) {
                    script {
                        echo "🔵 Starting blue-green deployment to k3s"

                        withEnv(["JWT_SECRET=${JWT_SECRET}", "DB_PASSWORD=${DB_PASSWORD}", "DATABASE_URL=${DATABASE_URL}", "CLIENT_SECRET=${CLIENT_SECRET}"]) {
                            sh """
                                helm upgrade --install ${NEW_RELEASE} ${HELM_CHART_PATH} \
                                    --values ${HELM_CHART_PATH}/values.yaml \
                                    --values helm/values-override.yaml \
                                    --set color=${NEW_COLOR} \
                                    --set secrets.JWT_SECRET=\${JWT_SECRET} \
                                    --set secrets.DB_PASSWORD=\${DB_PASSWORD} \
                                    --set secrets.DATABASE_URL=\${DATABASE_URL} \
                                    --set secrets.CLIENT_SECRET=\${CLIENT_SECRET} \
                                    --namespace ${K3S_NAMESPACE}
                            """
                        }
                        
                        // Wait for rollout
                        sleep 5
                        sh "kubectl rollout status deployment/${NEW_RELEASE} -n ${K3S_NAMESPACE} --timeout=1m"
                        
                        // Test new deployment directly via port-forward
                        echo "⏳ Testing new container (${NEW_COLOR})..."
                        sh '''
                            pod=$(kubectl get pod -l app=auth-service,color=${NEW_COLOR} -o jsonpath='{.items[0].metadata.name}' -n ${K3S_NAMESPACE})
                            if [ -z "$pod" ]; then
                                echo "❌ No pod found for ${NEW_COLOR}"
                                exit 1
                            fi
                            kubectl port-forward pod/$pod 8080:${APP_PORT} -n ${K3S_NAMESPACE} &
                            sleep 2
                            for i in {1..30}; do
                                if curl -f http://localhost:8080/health; then  # Adjust /health to your endpoint
                                    echo "✅ New container is ready!"
                                    break
                                fi
                                echo "Attempt $i/30 - waiting 3 seconds..."
                                sleep 3
                                if [ $i -eq 30 ]; then
                                    echo "❌ New container failed health check"
                                    kubectl logs -n ${K3S_NAMESPACE} pod/$pod
                                    kill %1
                                    exit 1
                                fi
                            done
                            kill %1  # Stop port-forward
                        '''
                        
                        // Switch traffic by patching service
                        sh """
                            kubectl patch svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} -p '{\"spec\":{\"selector\":{\"color\":\"${NEW_COLOR}\"}}}'
                        """
                        echo "🔄 Traffic switched to ${NEW_COLOR}"

                        // Cleanup old environment
                        sh "helm uninstall ${OLD_RELEASE} --namespace ${K3S_NAMESPACE} || true"
                    }
                }
            }
        }

        stage('Deploy Cloudflare Tunnel') {
            steps {
                withCredentials([string(credentialsId: 'cloudflare-tunnel-token', variable: 'CLOUDFLARE_TOKEN')]) {
                    script {
                        echo "🚀 Deploying/Updating Cloudflare Tunnel for external access"
                        // Create or update the Secret with the token from Jenkins credentials
                        sh """
                            kubectl create namespace cloudflare --dry-run=client -o yaml | kubectl apply -f -
                            kubectl create secret generic tunnel-credentials \
                                --namespace cloudflare \
                                --from-literal=token="\${CLOUDFLARE_TOKEN}" \
                                --dry-run=client -o yaml | kubectl apply -f -
                        """
                        // Apply the rest of the YAML (Namespace and Deployment)
                        sh "kubectl apply -f cloudflare-tunnel.yaml"
                        // Wait for rollout
                        sh "kubectl rollout status deployment/cloudflared -n cloudflare --timeout=2m"
                    }
                }
            }
        }

        stage('Final Health Check') {
            steps {
                sh '''
                    echo "🏥 Final health verification..."
                    # Internal check via cluster DNS
                    curl -f http://${SERVICE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}/health || exit 1
                    
                    echo "📊 Pods status:"
                    kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service -o wide
                    
                    echo "📊 Service status:"
                    kubectl get svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} -o wide
                '''
            }
        }

        stage('🧹 Deep Cleanup') {
            steps {
                sh '''
                    echo "🧹 Starting comprehensive cleanup..."
                    
                    echo "📦 Disk usage BEFORE cleanup:"
                    df -h /var/lib/docker | tail -1
                    docker system df
                    
                    echo "🗑️ Removing old and dangling images..."
                    docker image prune -a -f --filter until=24h
                    
                    echo "🗑️ Removing stopped containers..."
                    docker container prune -f --filter until=1h
                    
                    echo "🗑️ Removing unused networks..."
                    docker network prune -f
                    
                    echo "🗑️ Removing unused volumes..."
                    docker volume prune -f
                    
                    echo "🗑️ Cleaning build cache..."
                    docker builder prune -a -f --filter until=6h
                    
                    echo "🗑️ Removing old Docker Hub images (keep latest 2)..."
                    docker images ${DOCKER_IMAGE} --format "{{.ID}}" | tail -n +3 | xargs -r docker rmi -f || true
                    
                    echo "🗑️ Force cleanup of everything unused..."
                    docker system prune -a -f --volumes
                    
                    echo "📦 Disk usage AFTER cleanup:"
                    df -h /var/lib/docker | tail -1
                    docker system df
                    
                    echo "🎯 Cleanup completed!"
                '''
            }
        }
    }

    post {
        always {
            sh 'docker logout || true'
        }
        failure {
            sh '''
                echo "❌ Deployment failed - emergency cleanup..."
                kubectl delete pod -n ${K3S_NAMESPACE} -l app=auth-service --force --grace-period=0 || true
                kubectl delete deployment -n ${K3S_NAMESPACE} -l app=auth-service || true
                kubectl logs -n ${K3S_NAMESPACE} -l app=auth-service || true
                kubectl describe pods -n ${K3S_NAMESPACE} -l app=auth-service || true
                docker container prune -f || true
                docker image prune -f || true
            '''
        }
        success {
            sh '''
                echo "✅ Auto-deployment successful!"
                echo "🔗 Triggered by: GitHub push"
                echo "📦 Image: ${DOCKER_IMAGE}:${DOCKER_TAG}"
                echo "🌐 Internal access: http://${SERVICE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}"
                echo "🌐 External access: https://auth.pokharelsujan.info.np (via Cloudflare Tunnel)"
                echo "📊 Final system status:"
                kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service --no-headers -o custom-columns="NAME:.metadata.name,STATUS:.status.phase"
                free -h | head -2
            '''
        }
    }
}
