# SSH to Raspberry Pi
ssh pi@192.168.1.x

# Install OCI CLI
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"

# Configure OCI
oci setup config

# Download kubeconfig
# Fix directory ownership
sudo chown -R pi:pi /var/lib/jenkins/.kube

# Download kubeconfig as your user first
oci ce cluster create-kubeconfig \
  --cluster-id ocid1.cluster.oc1.ap-tokyo-1.aaaaaaaa5rm4c3r5ke6jht6crjqofes6g4kaqnavpvd42kmfpcg6trwc55ua \
  --file /var/lib/jenkins/.kube/oke-config \
  --region ap-tokyo-1

# Now change ownership to jenkins
sudo chown -R jenkins:jenkins /var/lib/jenkins/.kube
sudo chmod 600 /var/lib/jenkins/.kube/oke-config


# Expected output:
# New config written to the Kubeconfig file /var/lib/jenkins/.kube/oke-config


# Set permissions
sudo chown jenkins:jenkins /var/lib/jenkins/.kube/oke-config
sudo chmod 600 /var/lib/jenkins/.kube/oke-config

# Test
sudo -u jenkins kubectl --kubeconfig=/var/lib/jenkins/.kube/oke-config get nodes


# Copy OCI config to Jenkins home
sudo cp -r ~/.oci /var/lib/jenkins/

# Set ownership to jenkins
sudo chown -R jenkins:jenkins /var/lib/jenkins/.oci

# Set secure permissions on private key
sudo chmod 600 /var/lib/jenkins/.oci/oci_api_key.pem
