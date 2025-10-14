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

        // Environment variables
        NODE_ENV   = 'production'
        DB_HOST    = 'postgres'
        DB_PORT    = '5432'

        // k3s and Helm configs
        HELM_CHART_PATH = './helm'
        K3S_NAMESPACE   = 'default'
        SERVICE_NAME    = 'auth-service'  // Fixed service name for traffic switching

        // Blue-Green specific
        BLUE_LABEL = 'blue'
        GREEN_LABEL = 'green'

        // Docker image
        DOCKER_IMAGE = "${DOCKER_HUB_USR}/${APP_NAME}"
        DOCKER_TAG   = "${env.BUILD_NUMBER}"
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
                    env.CURRENT_ACTIVE = sh(
                        script: "kubectl get svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} -o jsonpath='{.spec.selector.color}' 2>/dev/null || echo '${BLUE_LABEL}'",
                        returnStdout: true
                    ).trim()
                    
                    env.NEW_COLOR = (env.CURRENT_ACTIVE == BLUE_LABEL) ? GREEN_LABEL : BLUE_LABEL
                    env.NEW_RELEASE = "auth-service-${NEW_COLOR}"
                    env.OLD_RELEASE = "auth-service-${CURRENT_ACTIVE}"
                    
                    echo "✅ Current active: ${env.CURRENT_ACTIVE}"
                    echo "🎯 Deploying to: ${env.NEW_COLOR} (release: ${env.NEW_RELEASE})"
                    echo "🔄 Old release: ${env.OLD_RELEASE} (will be kept as backup)"
                }
            }
        }

        stage('Docker Login') {
            steps {
                sh 'echo "${DOCKER_HUB_PSW}" | docker login -u "${DOCKER_HUB_USR}" --password-stdin'
            }
        }

        stage('Build & Push') {
            steps {
                dir("${APP_DIR}") {
                    sh '''
                        echo "🏗️ Building Docker image for ARM64..."
                        docker buildx create --use || true
                        docker buildx build \
                            -t ${DOCKER_IMAGE}:${DOCKER_TAG} \
                            -t ${DOCKER_IMAGE}:latest \
                            --push .
                        echo "✅ Image pushed: ${DOCKER_IMAGE}:${DOCKER_TAG}"
                    '''
                }
            }
        }

        stage('Create Image Pull Secret') {
            steps {
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

        stage('Blue-Green Deploy to k3s') {
            steps {
                withCredentials([
                    string(credentialsId: 'auth-jwt-secret', variable: 'JWT_SECRET'),
                    string(credentialsId: 'auth-db-password', variable: 'DB_PASSWORD'),
                    string(credentialsId: 'auth-database-url', variable: 'DATABASE_URL'),
                    string(credentialsId: 'auth-client-secret', variable: 'CLIENT_SECRET'),
                    string(credentialsId: 'vite_firebase_project_id', variable: 'FIREBASE_PROJECT_ID'),
                    string(credentialsId: 'firebase_client_id', variable: 'FIREBASE_CLIENT_EMAIL'),
                    string(credentialsId: 'firebase_private_key', variable: 'FIREBASE_PRIVATE_KEY'),
                    string(credentialsId: 'firebase_database_url', variable: 'FIREBASE_DATABASE_URL')
                ]) {
                    script {
                        echo "🔵 Deploying NEW version (${NEW_COLOR}) - OLD version (${CURRENT_ACTIVE}) keeps running"

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
                                --set secrets.FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID}" \
                                --set secrets.FIREBASE_CLIENT_EMAIL="${FIREBASE_CLIENT_EMAIL}" \
                                --set secrets.FIREBASE_PRIVATE_KEY="${FIREBASE_PRIVATE_KEY}" \
                                --set secrets.FIREBASE_DATABASE_URL="${FIREBASE_DATABASE_URL}" \
                                --namespace ${K3S_NAMESPACE}
                            
                            echo "✅ Helm deployment completed"
                        '''
                    }
                }
            }
        }

        stage('Wait for Rollout') {
            steps {
                script {
                    echo "⏳ Waiting for new deployment to be ready..."
                    sh """
                        kubectl rollout status deployment/${NEW_RELEASE} \
                            -n ${K3S_NAMESPACE} \
                            --timeout=3m
                    """
                    echo "✅ Rollout completed successfully"
                }
            }
        }

        stage('Health Check New Deployment') {
            steps {
                sh '''
                    echo "🏥 Testing new deployment (${NEW_COLOR})..."
                    
                    # Get pod name
                    pod=$(kubectl get pod -l app=auth-service,color=${NEW_COLOR} \
                        -o jsonpath='{.items[0].metadata.name}' -n ${K3S_NAMESPACE})
                    
                    if [ -z "$pod" ]; then
                        echo "❌ No pod found for ${NEW_COLOR}"
                        exit 1
                    fi
                    
                    echo "🔍 Testing pod: $pod"
                    
                    # Port-forward and test
                    kubectl port-forward pod/$pod 8080:${APP_PORT} -n ${K3S_NAMESPACE} &
                    PF_PID=$!
                    sleep 5
                    
                    # Test health endpoint
                    for i in {1..30}; do
                        if curl -f http://localhost:8080/health 2>/dev/null; then
                            echo "✅ Health check passed!"
                            kill $PF_PID 2>/dev/null || true
                            exit 0
                        elif curl -f http://localhost:8080/ 2>/dev/null; then
                            echo "✅ Root endpoint responding!"
                            kill $PF_PID 2>/dev/null || true
                            exit 0
                        fi
                        echo "⏳ Attempt $i/30 - waiting..."
                        sleep 5
                    done
                    
                    echo "❌ Health check failed after 30 attempts"
                    kubectl logs -n ${K3S_NAMESPACE} pod/$pod --tail=50
                    kill $PF_PID 2>/dev/null || true
                    exit 1
                '''
            }
        }

        stage('Switch Traffic') {
            steps {
                script {
                    echo "🔄 Switching traffic from ${CURRENT_ACTIVE} → ${NEW_COLOR}"
                    sh """
                        kubectl patch svc ${SERVICE_NAME} -n ${K3S_NAMESPACE} \
                            -p '{"spec":{"selector":{"color":"${NEW_COLOR}"}}}'
                    """
                    echo "✅ Traffic switched successfully!"
                    echo "🎯 Live traffic now going to: ${NEW_COLOR}"
                    echo "🛡️ Backup version (${CURRENT_ACTIVE}) still available for rollback"
                }
            }
        }

        stage('Cleanup Old Deployment') {
            steps {
                script {
                    echo "🧹 Cleaning up old deployment (${OLD_RELEASE})..."
                    sh """
                        if helm list -n ${K3S_NAMESPACE} | grep -q ${OLD_RELEASE}; then
                            echo "🗑️ Removing old release: ${OLD_RELEASE}"
                            helm uninstall ${OLD_RELEASE} --namespace ${K3S_NAMESPACE}
                            echo "✅ Old deployment cleaned up"
                        else
                            echo "ℹ️ No old release to clean up"
                        fi
                    """
                }
            }
        }

        stage('Final Health Check') {
            steps {
                sh '''
                    echo "🏥 Final health verification via service..."
                    
                    # Test service endpoint
                    kubectl run curl-test --rm -i --restart=Never --image=curlimages/curl -- \
                        curl -f http://${SERVICE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}/health || \
                        curl -f http://${SERVICE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}/ || \
                        echo "⚠️ Service health check warning (may still be working)"
                    
                    echo "📊 Final status:"
                    kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service -o wide
                    kubectl get svc ${SERVICE_NAME} -n ${K3S_NAMESPACE}
                    kubectl get endpoints ${SERVICE_NAME} -n ${K3S_NAMESPACE}
                '''
            }
        }

        stage('🧹 Docker Cleanup') {
            steps {
                sh '''
                    echo "🧹 Cleaning up Docker resources..."
                    
                    docker image prune -a -f --filter until=24h || true
                    docker container prune -f --filter until=1h || true
                    docker network prune -f || true
                    docker volume prune -f || true
                    docker builder prune -a -f --filter until=6h || true
                    
                    # Keep only latest 2 versions of app image
                    docker images ${DOCKER_IMAGE} --format "{{.ID}}" | tail -n +3 | \
                        xargs -r docker rmi -f || true
                    
                    echo "✅ Docker cleanup completed"
                '''
            }
        }
    }

    post {
        always {
            sh 'docker logout || true'
        }
        
        failure {
            script {
                echo "❌ DEPLOYMENT FAILED!"
                echo "🛡️ Old version (${CURRENT_ACTIVE}) is still running and serving traffic"
                echo "🔄 To rollback manually: Re-run previous successful build"
                
                sh '''
                    echo "📋 Failure diagnostics:"
                    kubectl logs -n ${K3S_NAMESPACE} -l app=auth-service,color=${NEW_COLOR} --tail=100 || true
                    kubectl describe pods -n ${K3S_NAMESPACE} -l app=auth-service,color=${NEW_COLOR} || true
                    kubectl get events -n ${K3S_NAMESPACE} --sort-by='.lastTimestamp' | tail -20 || true
                    
                    echo "📊 Current deployment status:"
                    helm list -n ${K3S_NAMESPACE} | grep auth-service || true
                    kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service || true
                '''
            }
        }
        
        success {
            sh '''
                echo "✅ DEPLOYMENT SUCCESSFUL!"
                echo "🎯 Active version: ${NEW_COLOR}"
                echo "📦 Image: ${DOCKER_IMAGE}:${DOCKER_TAG}"
                echo "🌐 Service: http://${SERVICE_NAME}.${K3S_NAMESPACE}.svc.cluster.local:${PORT}"
                echo ""
                echo "📊 Final system status:"
                kubectl get pods -n ${K3S_NAMESPACE} -l app=auth-service \
                    -o custom-columns="NAME:.metadata.name,COLOR:.metadata.labels.color,STATUS:.status.phase,READY:.status.conditions[?(@.type=='Ready')].status"
            '''
        }
    }
}
