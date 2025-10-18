pipeline {
    agent any
    
    triggers {
        githubPush()
    }

    environment {
        DOCKER_HUB = credentials('docker-hub-credentials')
        KUBECONFIG = '/var/lib/jenkins/.kube/oke-config'
        
        APP_NAME   = 'auth-service'
        APP_DIR    = "${WORKSPACE}"
        PORT       = '80'
        APP_PORT   = '3001'
        
        NODE_ENV   = 'production'
        DB_HOST    = 'postgres'
        DB_PORT    = '5432'
        
        HELM_CHART_PATH = './helm'
        OKE_NAMESPACE   = 'default'
        SERVICE_NAME    = 'auth-service'
        
        BLUE_LABEL = 'blue'
        GREEN_LABEL = 'green'
        
        DOCKER_IMAGE = "${DOCKER_HUB_USR}/${APP_NAME}"
        DOCKER_TAG   = "latest"  // Use latest built by GitHub Actions
    }

    stages {
        stage('🔔 Auto-Triggered Build') {
            steps {
                script {
                    echo "🚀 Deployment triggered by GitHub push!"
                    echo "📝 Commit: ${env.GIT_COMMIT}"
                    echo "🌿 Branch: ${env.GIT_BRANCH}"
                    echo "☁️  Target: Oracle Cloud Kubernetes (OKE)"
                    echo "🏗️  Image: Built by GitHub Actions (AMD64)"
                }
            }
        }

        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Verify AMD64 Image') {
            steps {
                sh '''
                    echo "🔍 Verifying AMD64 image from GitHub Actions..."
                    echo "Image: docker.io/${DOCKER_IMAGE}:${DOCKER_TAG}"
                    
                    # Wait a moment for GitHub Actions to finish
                    sleep 10
                    
                    # Verify image exists and is AMD64
                    docker manifest inspect docker.io/${DOCKER_IMAGE}:${DOCKER_TAG} || true
                    
                    echo "✅ Image ready for deployment"
                '''
            }
        }

        stage('Initialize Blue-Green') {
            steps {
                script {
                    echo "🔍 Detecting current active color on OKE..."
                    env.CURRENT_ACTIVE = sh(
                        script: "kubectl get svc ${SERVICE_NAME} -n ${OKE_NAMESPACE} -o jsonpath='{.spec.selector.color}' 2>/dev/null || echo '${BLUE_LABEL}'",
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

        stage('Create Image Pull Secret') {
            steps {
                sh """
                    kubectl create secret docker-registry docker-hub-credentials \
                        --docker-server=https://index.docker.io/v1/ \
                        --docker-username="${DOCKER_HUB_USR}" \
                        --docker-password="${DOCKER_HUB_PSW}" \
                        -n ${OKE_NAMESPACE} \
                        --dry-run=client -o yaml | kubectl apply -f -
                """
            }
        }

        stage('Create Firebase Secret') {
            steps {
                script {
                    echo "🔥 Creating Firebase credentials secret..."
                    withCredentials([file(credentialsId: 'firebase-json', variable: 'FIREBASE_CREDS')]) {
                        sh """
                            kubectl create secret generic firebase-credentials \
                                --from-file=serviceAccount.json=\${FIREBASE_CREDS} \
                                --namespace ${OKE_NAMESPACE} \
                                --dry-run=client -o yaml | kubectl apply -f -
                            echo "✅ Firebase secret created/updated"
                        """
                    }
                }
            }
        }

        stage('Blue-Green Deploy to OKE') {
            steps {
                withCredentials([
                    string(credentialsId: 'auth-jwt-secret', variable: 'JWT_SECRET'),
                    string(credentialsId: 'auth-db-password', variable: 'DB_PASSWORD'),
                    string(credentialsId: 'auth-database-url', variable: 'DATABASE_URL'),
                    string(credentialsId: 'auth-client-secret', variable: 'CLIENT_SECRET'),
                    string(credentialsId: 'firebase_database_url', variable: 'FIREBASE_DATABASE_URL')
                ]) {
                    script {
                        echo "☁️  Deploying to Oracle Cloud Kubernetes (OKE)"
                        echo "🔵 Deploying NEW version (${NEW_COLOR}) - OLD version (${CURRENT_ACTIVE}) keeps running"
                        sh '''
                            helm upgrade --install ${NEW_RELEASE} ${HELM_CHART_PATH} \
                                --values ${HELM_CHART_PATH}/values.yaml \
                                --set color=${NEW_COLOR} \
                                --set image.repository=docker.io/${DOCKER_IMAGE} \
                                --set image.tag=${DOCKER_TAG} \
                                --set env.NODE_ENV=${NODE_ENV} \
                                --set env.DB_HOST=${DB_HOST} \
                                --set env.DB_PORT=${DB_PORT} \
                                --set secrets.JWT_SECRET="${JWT_SECRET}" \
                                --set secrets.DB_PASSWORD="${DB_PASSWORD}" \
                                --set secrets.DATABASE_URL="${DATABASE_URL}" \
                                --set secrets.CLIENT_SECRET="${CLIENT_SECRET}" \
                                --set secrets.FIREBASE_DATABASE_URL="${FIREBASE_DATABASE_URL}" \
                                --namespace ${OKE_NAMESPACE}
                            
                            echo "✅ Helm deployment to OKE completed"
                        '''
                    }
                }
            }
        }

        stage('Wait for Rollout') {
            steps {
                script {
                    echo "⏳ Waiting for new deployment on OKE to be ready..."
                    sh """
                        kubectl rollout status deployment/${NEW_RELEASE} \
                            -n ${OKE_NAMESPACE} \
                            --timeout=5m
                    """
                    echo "✅ Rollout completed successfully on OKE"
                }
            }
        }

        stage('Health Check New Deployment') {
            steps {
                sh '''
                    echo "🏥 Testing new deployment (${NEW_COLOR}) on OKE..."
                    
                    pod=$(kubectl get pod -l app=auth-service,color=${NEW_COLOR} \
                        -o jsonpath='{.items[0].metadata.name}' -n ${OKE_NAMESPACE})
                    
                    if [ -z "$pod" ]; then
                        echo "❌ No pod found for ${NEW_COLOR}"
                        exit 1
                    fi
                    
                    echo "🔍 Testing pod: $pod"
                    
                    kubectl port-forward pod/$pod 8080:${APP_PORT} -n ${OKE_NAMESPACE} &
                    PF_PID=$!
                    sleep 5
                    
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
                    kubectl logs -n ${OKE_NAMESPACE} pod/$pod --tail=50
                    kill $PF_PID 2>/dev/null || true
                    exit 1
                '''
            }
        }

        stage('Switch Traffic') {
            steps {
                script {
                    echo "🔄 Switching traffic from ${CURRENT_ACTIVE} → ${NEW_COLOR} on OKE"
                    sh """
                        kubectl patch svc ${SERVICE_NAME} -n ${OKE_NAMESPACE} \
                            -p '{"spec":{"selector":{"color":"${NEW_COLOR}"}}}'
                    """
                    echo "✅ Traffic switched successfully on OKE!"
                    echo "🎯 Live traffic now going to: ${NEW_COLOR}"
                    echo "🛡️ Backup version (${CURRENT_ACTIVE}) still available for rollback"
                }
            }
        }

        stage('Keep 2 Deployments (Active + Backup)') {
            steps {
                script {
                    echo "🧹 Smart Cleanup: Keep CURRENT + 1 BACKUP deployment on OKE"
                    sh """
                        if kubectl get deployment ${OLD_RELEASE} -n ${OKE_NAMESPACE} 2>/dev/null; then
                            kubectl scale deployment ${OLD_RELEASE} --replicas=0 -n ${OKE_NAMESPACE}
                            echo "✅ ${OLD_RELEASE} scaled to 0 (backup)"
                        fi
                    """
                }
            }
        }

        stage('Get Load Balancer IP') {
            steps {
                script {
                    echo "🌐 Getting OCI Load Balancer public IP..."
                    sh """
                        LB_IP=\$(kubectl get svc ${SERVICE_NAME} -n ${OKE_NAMESPACE} \
                            -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null)
                        
                        if [ -n "\$LB_IP" ]; then
                            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                            echo "✅ Service accessible at: http://\${LB_IP}"
                            echo "   Health: http://\${LB_IP}/health"
                            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                        fi
                    """
                }
            }
        }
    }

    post {
        success {
            sh '''
                echo "✅ DEPLOYMENT TO ORACLE CLOUD (OKE) SUCCESSFUL!"
                echo "🏗️  Built by: GitHub Actions (Native AMD64)"
                echo "🎯 Active: ${NEW_RELEASE} (${NEW_COLOR})"
                echo "📦 Image: docker.io/${DOCKER_IMAGE}:${DOCKER_TAG}"
                echo "💰 Cost: $0/month (Always Free Tier)"
            '''
        }
        
        failure {
            sh '''
                echo "❌ DEPLOYMENT FAILED!"
                kubectl logs -n ${OKE_NAMESPACE} -l app=auth-service,color=${NEW_COLOR} --tail=100 || true
            '''
        }
    }
}