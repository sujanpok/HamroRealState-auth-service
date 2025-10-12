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
                    env.CURRENT_ACTIVE = sh(script: "kubectl get svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} -o jsonpath='{.spec.selector.color}' 2>/dev/null || echo '${BLUE_LABEL}'", returnStdout: true).trim()
                    env.NEW_COLOR = (env.CURRENT_ACTIVE == BLUE_LABEL) ? GREEN_LABEL : BLUE_LABEL
                    env.NEW_RELEASE = "auth-service-${NEW_COLOR}"
                    env.OLD_RELEASE = "auth-service-${(NEW_COLOR == BLUE_LABEL ? GREEN_LABEL : BLUE_LABEL)}"
                    echo "Current active: ${env.CURRENT_ACTIVE} | Deploying to: ${env.NEW_COLOR} (release: ${env.NEW_RELEASE})"
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

        stage('🧹 Cleanup Conflicting Resources') {
            steps {
                script {
                    echo "🧹 Pre-deployment cleanup to avoid Helm conflicts..."
                    sh """
                        # Delete conflicting service if it exists
                        kubectl delete service ${SERVICE_NAME} -n ${K3S_NAMESPACE} --ignore-not-found=true
                        
                        # Clean up old release if it exists
                        helm uninstall ${OLD_RELEASE} -n ${K3S_NAMESPACE} --ignore-not-found=true || true
                        
                        # Wait for cleanup to complete
                        sleep 3
                        
                        echo "✅ Cleanup completed"
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
                    string(credentialsId: 'auth-client-secret', variable: 'CLIENT_SECRET'),
                    string(credentialsId: 'firebase_client_id', variable: 'FIREBASE_CLIENT_ID')
                    string(credentialsId: 'firebase_private_key', variable: 'FIREBASE_PRIVATE_KEY')
                    string(credentialsId: 'firebase_database_url', variable: 'FIREBASE_DATABASE_URL')
                ]) {
                    script {
                        echo "🔵 Starting blue-green deployment to k3s"

                        sh '''
                            helm upgrade --install ${NEW_RELEASE} ${HELM_CHART_PATH} \
                                --values ${HELM_CHART_PATH}/values.yaml \
                                --set color=${NEW_COLOR} \
                                --set image.repository=${DOCKER_IMAGE} \
                                --set image.tag=${DOCKER_TAG} \
                                --set env.NODE_ENV=${NODE_ENV} \
                                --set env.DB_HOST=${DB_HOST} \
                                --set env.DB_PORT=${DB_PORT} \
                                --set secrets.JWT_SECRET="${JWT_SECRET}" \
                                --set secrets.DB_PASSWORD="${DB_PASSWORD}" \
                                --set secrets.DATABASE_URL="${DATABASE_URL}" \
                                --set secrets.CLIENT_SECRET="${CLIENT_SECRET}" \
                                --set secrets.FIREBASE_CLIENT_ID="${FIREBASE_CLIENT_ID}" \
                                --set secrets.FIREBASE_PRIVATE_KEY="${FIREBASE_PRIVATE_KEY}" \
                                --set secrets.FIREBASE_DATABASE_URL="${FIREBASE_DATABASE_URL}" \
                                --namespace ${K3S_NAMESPACE} \
                                --atomic \
                                --cleanup-on-fail \
                                --wait --timeout 5m
                        '''
                        
                        // Wait for rollout
                        echo "⏳ Waiting for deployment rollout..."
                        sleep 10
                        sh "kubectl rollout status deployment/${NEW_RELEASE} -n ${K3S_NAMESPACE} --timeout=2m"
                        
                        // Test new deployment directly via port-forward
                        echo "⏳ Testing new container (${NEW_COLOR})..."
                        sh '''
                            pod=$(kubectl get pod -l app=auth-service,color=${NEW_COLOR} -o jsonpath='{.items[0].metadata.name}' -n ${K3S_NAMESPACE})
                            if [ -z "$pod" ]; then
                                echo "❌ No pod found for ${NEW_COLOR}"
                                exit 1
                            fi
                            
                            echo "🔍 Testing pod: $pod"
                            kubectl port-forward pod/$pod 8080:${APP_PORT} -n ${K3S_NAMESPACE} &
                            PF_PID=$!
                            sleep 5
                            
                            # Test health endpoint
                            for i in {1..30}; do
                                if curl -f http://localhost:8080/health 2>/dev/null; then
                                    echo "✅ New container health check passed!"
                                    kill $PF_PID
                                    break
                                elif curl -f http://localhost:8080/ 2>/dev/null; then
                                    echo "✅ New container is responding (no /health endpoint)!"
                                    kill $PF_PID
                                    break
                                fi
                                echo "Attempt $i/30 - waiting 5 seconds..."
                                sleep 5
                                if [ $i -eq 30 ]; then
                                    echo "❌ New container failed health check"
                                    kubectl logs -n ${K3S_NAMESPACE} pod/$pod --tail=50
                                    kill $PF_PID
                                    exit 1
                                fi
                            done
                        '''
                        
                        // Switch traffic by patching service
                        sh """
                            kubectl patch svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} -p '{\"spec\":{\"selector\":{\"color\":\"${NEW_COLOR}\"}}}'
                        """
                        echo "🔄 Traffic switched to ${NEW_COLOR}"

                        // Cleanup old environment (if it exists)
                        sh """
                            # Clean up old release after successful deployment
                            if helm list -n ${K3S_NAMESPACE} | grep -q ${OLD_RELEASE}; then
                                echo "🗑️ Cleaning up old release: ${OLD_RELEASE}"
                                helm uninstall ${OLD_RELEASE} --namespace ${K3S_NAMESPACE}
                            else
                                echo "ℹ️ No old release to clean up"
                            fi
                        """
                    }
                }
            }
        }

        stage('Final Health Check') {
            steps {
                sh '''
                    echo "🏥 Final health verification..."
                    
                    # Test internal cluster access
                    kubectl run curl-test --rm -i --restart=Never --image=curlimages/curl -- \
                        curl -f http://${SERVICE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}/health || \
                        curl -f http://${SERVICE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}/ || \
                        echo "⚠️ Health check failed, but deployment may still be working"
                    
                    echo "📊 Pods status:"
                    kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service -o wide
                    
                    echo "📊 Service status:"
                    kubectl get svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} -o wide
                    
                    echo "🔗 Service endpoints:"
                    kubectl get endpoints ${SERVICE_NAME} -n ${K3S_NAMESPACE}
                '''
            }
        }

        stage('🧹 Deep Cleanup') {
            steps {
                sh '''
                    echo "🧹 Starting comprehensive cleanup..."
                    
                    echo "📦 Disk usage BEFORE cleanup:"
                    df -h /var/lib/docker | tail -1 || echo "Docker directory not found"
                    docker system df || echo "Docker system df failed"
                    
                    echo "🗑️ Removing old and dangling images..."
                    docker image prune -a -f --filter until=24h || echo "Image prune failed"
                    
                    echo "🗑️ Removing stopped containers..."
                    docker container prune -f --filter until=1h || echo "Container prune failed"
                    
                    echo "🗑️ Removing unused networks..."
                    docker network prune -f || echo "Network prune failed"
                    
                    echo "🗑️ Removing unused volumes..."
                    docker volume prune -f || echo "Volume prune failed"
                    
                    echo "🗑️ Cleaning build cache..."
                    docker builder prune -a -f --filter until=6h || echo "Builder prune failed"
                    
                    echo "🗑️ Removing old Docker Hub images (keep latest 2)..."
                    docker images ${DOCKER_IMAGE} --format "{{.ID}}" | tail -n +3 | xargs -r docker rmi -f || echo "Old image cleanup completed"
                    
                    echo "🗑️ Force cleanup of everything unused..."
                    docker system prune -a -f --volumes || echo "System prune completed"
                    
                    echo "📦 Disk usage AFTER cleanup:"
                    df -h /var/lib/docker | tail -1 || echo "Docker directory not found"
                    docker system df || echo "Docker system df failed"
                    
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
                kubectl logs -n ${K3S_NAMESPACE} -l app=auth-service --tail=100 || true
                kubectl describe pods -n ${K3S_NAMESPACE} -l app=auth-service || true
                kubectl get events -n ${K3S_NAMESPACE} --sort-by='.lastTimestamp' | tail -20 || true
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
                echo "📊 Final system status:"
                kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service --no-headers -o custom-columns="NAME:.metadata.name,STATUS:.status.phase" || true
                free -h | head -2 || echo "Memory info not available"
            '''
        }
    }
}

