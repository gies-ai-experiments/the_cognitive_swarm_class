# Terraform Deployment Notes

This module provisions the GCP foundation for one environment of The Cognitive Swarm:

- Artifact Registry
- Cloud Run service
- Memorystore Redis
- Firestore bootstrap support
- Secret Manager secret for `GEMINI_API_KEY`
- runtime and deployer service accounts
- GitHub Actions Workload Identity Federation
- serverless VPC connector
- remote Terraform state support via GCS backend

## Usage

1. Create a GCS bucket for Terraform state.
2. Render env-specific tfvars with `./infra/render-terraform-tfvars.sh <staging|prod> <output-path>`.
3. Run `terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=cognitive-swarm/<staging|prod>"`.
4. Apply once to create infra and outputs.
5. Configure `TERRAFORM_WIF_PROVIDER` and `TERRAFORM_SERVICE_ACCOUNT` for the Terraform GitHub Actions workflow.
6. Sync the GitHub environment variables from the outputs with `./infra/sync-github-variables-from-terraform.sh <staging|prod>`.
7. Let the deploy workflow read Terraform outputs from remote state and promote later revisions.

If you do not want Terraform to store the Gemini API key in state, leave `gemini_api_key_value` empty and create a secret version outside Terraform before enabling `inject_gemini_secret = true`.
