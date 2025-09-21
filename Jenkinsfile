pipeline {
    agent any
    
    triggers {
        githubPush()
    }

    environment {
        // Docker Hub
        DOCKER_HUB = credentials('docker-hub-credentials')

        // App configs
        APP_NAME   = 'auth-service'
        APP_DIR    = "${WORKSPACE}"
        PORT       = '80'  // External port for LoadBalancer

        // Environment variables (adapt from your config.js/db.js)
        NODE_ENV   = 'production'
        DB_HOST    = 'postgres'
        DB_PORT    = '5432'

        // k3s and Helm configs
        HELM_RELEASE_NAME = 'auth-release'
        HELM_CHART_PATH   = './helm'  // Path to your Helm chart
        K3S_NAMESPACE     = 'default'  // Or your preferred namespace

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
                    env.CURRENT_ACTIVE = sh(script: "kubectl get svc ${HELM_RELEASE_NAME} -n ${K3S_NAMESPACE} -o jsonpath='{.spec.selector.color}' || echo '${BLUE_LABEL}'", returnStdout: true).trim()
                    env.NEW_COLOR = (env.CURRENT_ACTIVE == BLUE_LABEL) ? GREEN_LABEL : BLUE_LABEL
                    echo "Current active: ${env.CURRENT_ACTIVE} | Deploying to: ${env.NEW_COLOR}"
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
                         docker build -t ${DOCKER_IMAGE}:${DOCKER_TAG} .
                        docker push ${DOCKER_IMAGE}:${DOCKER_TAG}
                    '''
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

                        // Deploy to the new color using Helm, injecting secrets via --set
                        sh """
                            helm upgrade --install ${HELM_RELEASE_NAME} ${HELM_CHART_PATH} \
                                --values ${HELM_CHART_PATH}/values.yaml \
                                --values helm/values-override.yaml \
                                --set color=${NEW_COLOR} \
                                --set secrets.JWT_SECRET="${JWT_SECRET}" \
                                --set secrets.DB_PASSWORD="${DB_PASSWORD}" \
                                --set secrets.DATABASE_URL="${DATABASE_URL}" \
                                --set secrets.CLIENT_SECRET="${CLIENT_SECRET}" \
                                --namespace ${K3S_NAMESPACE}
                        """
                        
                        // Wait for rollout
                        sh "kubectl rollout status deployment/${HELM_RELEASE_NAME} -n ${K3S_NAMESPACE} --timeout=5m"
                        
                        // Test new deployment (adapt to your health endpoint)
                        echo "⏳ Testing new container (${NEW_COLOR})..."
                        for (int i = 1; i <= 30; i++) {
                            def testResult = sh(script: "curl -f http://${HELM_RELEASE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}/health || true", returnStdout: true).trim()
                            if (testResult.contains("OK")) {  // Adapt to your app's health response
                                echo "✅ New container is ready!"
                                break
                            }
                            echo "Attempt $i/30 - waiting 3 seconds..."
                            sleep 3
                            if (i == 30) {
                                echo "❌ New container failed health check"
                                sh "kubectl logs -n ${K3S_NAMESPACE} -l app=auth-service,color=${NEW_COLOR}"
                                error "Health check failed"
                            }
                        }
                        
                        // Switch traffic by patching service
                        sh """
                            kubectl patch svc ${HELM_RELEASE_NAME} -n ${K3S_NAMESPACE} -p '{\"spec\":{\"selector\":{\"color\":\"${NEW_COLOR}\"}}}'
                        """
                        echo "🔄 Traffic switched to ${NEW_COLOR}"

                        // Cleanup old environment
                        def oldColor = (NEW_COLOR == BLUE_LABEL) ? GREEN_LABEL : BLUE_LABEL
                        sh "helm uninstall ${HELM_RELEASE_NAME} --namespace ${K3S_NAMESPACE} || true"
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
                    curl -f http://${HELM_RELEASE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}/health || exit 1
                    
                    echo "📊 Pods status:"
                    kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service -o wide
                    
                    echo "📊 Service status:"
                    kubectl get svc ${HELM_RELEASE_NAME} -n ${K3S_NAMESPACE} -o wide
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
                kubectl logs -n ${K3S_NAMESPACE} -l app=auth-service || true
                # Emergency cleanup (adapt as needed)
                docker container prune -f || true
                docker image prune -f || true
            '''
        }
        success {
            sh '''
                echo "✅ Auto-deployment successful!"
                echo "🔗 Triggered by: GitHub push"
                echo "📦 Image: ${DOCKER_IMAGE}:${DOCKER_TAG}"
                echo "🌐 Internal access: http://${HELM_RELEASE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}"
                echo "🌐 External access: [https://auth.pokharelsujan.info.np](https://auth.pokharelsujan.info.np) (via Cloudflare Tunnel)"
                echo "📊 Final system status:"
                kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service --format "table {{.NAME}}\t{{.STATUS}}"
                free -h | head -2
            '''
        }
    }
}
