#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./infra/sync-github-variables-from-terraform.sh <terraform-env> [github-environment]

Examples:
  ./infra/sync-github-variables-from-terraform.sh staging
  ./infra/sync-github-variables-from-terraform.sh prod production

This script expects to run after a successful `terraform apply` for the target
environment so `terraform output` reflects the current environment state.
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

if ! command -v terraform >/dev/null 2>&1; then
  echo "Error: terraform CLI not found." >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not found." >&2
  exit 1
fi

terraform_env="$1"
github_environment="${2:-}"

if [[ -z "$github_environment" ]]; then
  case "$terraform_env" in
    staging) github_environment="staging" ;;
    prod) github_environment="production" ;;
    *)
      echo "Error: unsupported terraform environment '$terraform_env'." >&2
      exit 1
      ;;
  esac
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
terraform_dir="${script_dir}/terraform"

cd "$terraform_dir"

tf_output() {
  terraform output -raw "$1"
}

set_repo_var() {
  gh variable set "$1" --body "$2"
}

set_env_var() {
  gh variable set "$1" --body "$2" -e "$github_environment"
}

project_id="$(tf_output project_id)"
region="$(tf_output region)"
artifact_registry_repository="$(tf_output artifact_registry_repository)"
firestore_collection="$(tf_output firestore_collection)"
gemini_secret_id="$(tf_output gemini_secret_id)"
app_environment="$(tf_output app_environment)"
cloud_run_service="$(tf_output cloud_run_service_name)"
deploy_wif_provider="$(tf_output deploy_workload_identity_provider)"
deploy_service_account="$(tf_output deploy_service_account_email)"
runtime_service_account="$(tf_output runtime_service_account_email)"
vpc_connector="$(tf_output vpc_connector_name)"
redis_host="$(tf_output redis_host)"
redis_port="$(tf_output redis_port)"
min_instances="$(tf_output min_instances)"
max_instances="$(tf_output max_instances)"

set_repo_var "GCP_PROJECT_ID" "$project_id"
set_repo_var "GCP_REGION" "$region"
set_repo_var "ARTIFACT_REGISTRY_REPOSITORY" "$artifact_registry_repository"
set_repo_var "FIRESTORE_COLLECTION" "$firestore_collection"
set_repo_var "GEMINI_SECRET_ID" "$gemini_secret_id"

set_env_var "APP_ENV" "$app_environment"
set_env_var "CLOUD_RUN_SERVICE" "$cloud_run_service"
set_env_var "DEPLOY_WIF_PROVIDER" "$deploy_wif_provider"
set_env_var "DEPLOY_SERVICE_ACCOUNT" "$deploy_service_account"
set_env_var "RUNTIME_SERVICE_ACCOUNT" "$runtime_service_account"
set_env_var "VPC_CONNECTOR" "$vpc_connector"
set_env_var "REDIS_HOST" "$redis_host"
set_env_var "REDIS_PORT" "$redis_port"
set_env_var "MIN_INSTANCES" "$min_instances"
set_env_var "MAX_INSTANCES" "$max_instances"

echo "Synced Terraform outputs to GitHub variables for ${github_environment}."
