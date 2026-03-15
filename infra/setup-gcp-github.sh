#!/usr/bin/env bash
set -euo pipefail

# Setup Script for The Cognitive Swarm Infrastructure
# This script configures GCP, bootstraps a remote Terraform backend, applies one
# environment, and syncs GitHub Actions variables from Terraform outputs.

if [ -z "$1" ]; then
    echo "Usage: ./infra/setup-gcp-github.sh <YOUR_GCP_PROJECT_ID> [staging|prod]"
    exit 1
fi

export GOOGLE_CLOUD_PROJECT=$1
export REGION="us-central1"
export GITHUB_REPO="$(git config --get remote.origin.url | sed -n 's#.*/\(.*\)/\(.*\)\.git#\1/\2#p' || echo "keshavdalmia10/the_cognitive_swarm")"
export TARGET_ENVIRONMENT="${2:-staging}"
export TERRAFORM_STATE_BUCKET="${TERRAFORM_STATE_BUCKET:-${GOOGLE_CLOUD_PROJECT}-cognitive-swarm-tfstate}"
export TERRAFORM_STATE_PREFIX="${TERRAFORM_STATE_PREFIX:-cognitive-swarm}"
export TERRAFORM_CI_WIF_PROVIDER="${TERRAFORM_CI_WIF_PROVIDER:-}"
export TERRAFORM_CI_SERVICE_ACCOUNT="${TERRAFORM_CI_SERVICE_ACCOUNT:-}"

case "$TARGET_ENVIRONMENT" in
  staging|prod) ;;
  *)
    echo "Error: environment must be 'staging' or 'prod'."
    exit 1
    ;;
esac

echo "====================================================="
echo "  Setting up Infrastructure for $GOOGLE_CLOUD_PROJECT"
echo "====================================================="

# Check requirements
if ! command -v gcloud &> /dev/null; then
    echo "Error: gcloud CLI not found. Please install it or run this script in Google Cloud Shell."
    exit 1
fi

if ! command -v terraform &> /dev/null; then
    echo "Error: terraform CLI not found. Please install terraform."
    exit 1
fi

if ! command -v gh &> /dev/null; then
    echo "Warning: gh CLI not found. You will need to set GitHub variables manually."
    GH_CLI_AVAILABLE=false
else
    GH_CLI_AVAILABLE=true
fi

# Ensure user is logged in
gcloud config set project "$GOOGLE_CLOUD_PROJECT"
echo "Authenticating Google Cloud..."

# Enable APIs
echo "Enabling GCP APIs..."
gcloud services enable \
  iamcredentials.googleapis.com \
  cloudresourcemanager.googleapis.com \
  sts.googleapis.com \
  secretmanager.googleapis.com \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  compute.googleapis.com \
  storage.googleapis.com \
  vpcaccess.googleapis.com \
  redis.googleapis.com \
  firestore.googleapis.com

# Create gemini-api-key secret
echo "Checking/Creating gemini-api-key secret..."
gcloud secrets create gemini-api-key --replication-policy="automatic" 2>/dev/null || echo "Secret already exists."

# Attempt reading .env automatically
if [ -f ".env" ]; then
    GEMINI_KEY=$(grep -E "^GEMINI_API_KEY=" .env | cut -d'"' -f2 | cut -d"'" -f2)
    if [ -n "$GEMINI_KEY" ]; then
        echo "Found GEMINI_API_KEY in .env, adding secret version..."
        echo -n "$GEMINI_KEY" | gcloud secrets versions add gemini-api-key --data-file=-
        echo "Secret version added successfully."
    fi
else
    echo "Please paste your GEMINI_API_KEY value:"
    read -rs GEMINI_KEY
    if [ -n "$GEMINI_KEY" ]; then
        echo -n "$GEMINI_KEY" | gcloud secrets versions add gemini-api-key --data-file=-
        echo "Secret version added successfully."
    else
        echo "Warning: No API key provided, skipping secret version update."
    fi
fi

echo "Ensuring remote Terraform state bucket exists..."
if ! gcloud storage buckets describe "gs://${TERRAFORM_STATE_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${TERRAFORM_STATE_BUCKET}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --location="${REGION}" \
    --uniform-bucket-level-access
fi
gcloud storage buckets update "gs://${TERRAFORM_STATE_BUCKET}" --versioning >/dev/null

echo "Rendering terraform variables for ${TARGET_ENVIRONMENT}..."
./infra/render-terraform-tfvars.sh "${TARGET_ENVIRONMENT}" "infra/terraform/environments/${TARGET_ENVIRONMENT}.tfvars"

# Terraform
echo "Applying terraform for ${TARGET_ENVIRONMENT} environment..."
cd infra/terraform
remote_state_path="gs://${TERRAFORM_STATE_BUCKET}/${TERRAFORM_STATE_PREFIX}/${TARGET_ENVIRONMENT}/default.tfstate"
if ! gcloud storage ls "$remote_state_path" >/dev/null 2>&1; then
  for candidate in "state/${TARGET_ENVIRONMENT}.tfstate" "terraform.tfstate"; do
    if [ -f "$candidate" ]; then
      echo "Migrating existing local state from ${candidate} to ${remote_state_path}..."
      gcloud storage cp "$candidate" "$remote_state_path" >/dev/null
      break
    fi
  done
fi

terraform init \
  -reconfigure \
  -backend-config="bucket=${TERRAFORM_STATE_BUCKET}" \
  -backend-config="prefix=${TERRAFORM_STATE_PREFIX}/${TARGET_ENVIRONMENT}"
terraform apply -auto-approve -var-file="environments/${TARGET_ENVIRONMENT}.tfvars"

# Wait for services to fully provision
sleep 5

if [ "$GH_CLI_AVAILABLE" = true ]; then
  echo "Saving Terraform backend settings to GitHub repository variables..."
  gh variable set TERRAFORM_STATE_BUCKET --body "${TERRAFORM_STATE_BUCKET}"
  gh variable set TERRAFORM_STATE_PREFIX --body "${TERRAFORM_STATE_PREFIX}"
  if [ -n "${TERRAFORM_CI_WIF_PROVIDER}" ] && [ -n "${TERRAFORM_CI_SERVICE_ACCOUNT}" ]; then
    gh variable set TERRAFORM_WIF_PROVIDER --body "${TERRAFORM_CI_WIF_PROVIDER}"
    gh variable set TERRAFORM_SERVICE_ACCOUNT --body "${TERRAFORM_CI_SERVICE_ACCOUNT}"
  else
    echo "Warning: TERRAFORM_CI_WIF_PROVIDER / TERRAFORM_CI_SERVICE_ACCOUNT not set; terraform.yml auth variables were not updated."
  fi

  echo "Syncing GitHub Actions variables from Terraform outputs..."
  github_environment="staging"
  if [ "$TARGET_ENVIRONMENT" = "prod" ]; then
    github_environment="production"
  fi
  ../sync-github-variables-from-terraform.sh "$TARGET_ENVIRONMENT" "$github_environment"
else
  echo -e "\n======================"
  echo "Please set the following GitHub Variables manually:"
  echo "- GCP_PROJECT_ID: $GOOGLE_CLOUD_PROJECT"
  echo "- GCP_REGION: $REGION"
  echo "- TERRAFORM_STATE_BUCKET: $TERRAFORM_STATE_BUCKET"
  echo "- TERRAFORM_STATE_PREFIX: $TERRAFORM_STATE_PREFIX"
  echo "- TERRAFORM_WIF_PROVIDER / TERRAFORM_SERVICE_ACCOUNT (for terraform.yml auth)"
  echo "- Then run ./infra/sync-github-variables-from-terraform.sh $TARGET_ENVIRONMENT"
  echo "Terraform deploy outputs are:"
  terraform output
fi

echo "Setup complete for ${TARGET_ENVIRONMENT}. Once variables are in GitHub, you can push to main to trigger the deploy workflow."
