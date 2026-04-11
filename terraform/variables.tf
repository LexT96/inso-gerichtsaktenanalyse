# ─── Hetzner ───
variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "server_name" {
  description = "Server name in Hetzner"
  type        = string
  default     = "aktenanalyse-demo"
}

variable "server_type" {
  description = "Hetzner server type (cx22 = 2 vCPU, 4 GB)"
  type        = string
  default     = "cx22"
}

variable "server_location" {
  description = "Hetzner datacenter (fsn1, nbg1, hel1)"
  type        = string
  default     = "fsn1"
}

variable "ssh_key_names" {
  description = "Pre-registered SSH key names in Hetzner Console"
  type        = list(string)
}

variable "ssh_source_ips" {
  description = "IP/CIDR whitelist for SSH (default: open)"
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
}

# ─── Domain (optional) ───
variable "domain" {
  description = "FQDN for the app. Leave empty for IP-only access (HTTP, no TLS)."
  type        = string
  default     = ""
}

# ─── App Secrets ───
variable "anthropic_api_key" {
  description = "Anthropic API key (or Langdock key)"
  type        = string
  sensitive   = true
}

variable "anthropic_base_url" {
  description = "Anthropic base URL override (empty = direct API, or Langdock/Azure URL)"
  type        = string
  default     = ""
}

variable "extraction_provider" {
  description = "Extraction provider: '' (Anthropic) or 'openai' (GPT-5.4)"
  type        = string
  default     = "openai"
}

variable "extraction_model" {
  description = "Model for extraction (Stage 2)"
  type        = string
  default     = "claude-sonnet-4-6"
}

variable "utility_model" {
  description = "Model for analysis & verification (Stage 1 + 3)"
  type        = string
  default     = "claude-haiku-4-5-20251001"
}

# ─── OpenAI (for GPT-5.4 extraction) ───
variable "openai_api_key" {
  description = "OpenAI API key for GPT-5.4 extraction"
  type        = string
  sensitive   = true
  default     = ""
}

variable "openai_model" {
  description = "OpenAI model name"
  type        = string
  default     = "gpt-5.4"
}

variable "openai_base_url" {
  description = "OpenAI base URL override (empty = default)"
  type        = string
  default     = ""
}

variable "openai_reasoning_effort" {
  description = "OpenAI reasoning effort (low/medium/high)"
  type        = string
  default     = "high"
}

variable "jwt_secret" {
  description = "JWT signing secret (min 32 chars)"
  type        = string
  sensitive   = true
}

variable "admin_password" {
  description = "Initial admin password"
  type        = string
  sensitive   = true
}

variable "db_encryption_key" {
  description = "AES-256-GCM key for SQLite encryption (min 32 chars)"
  type        = string
  sensitive   = true
}

# ─── Git ───
variable "git_repo_url" {
  description = "Git repository URL to clone on the server"
  type        = string
  default     = "https://github.com/LexT96/insolvenz-extraktor.git"
}

variable "git_branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "main"
}

# ─── Labels ───
variable "labels" {
  description = "Labels for the Hetzner resources"
  type        = map(string)
  default = {
    project    = "aktenanalyse"
    managed_by = "terraform"
  }
}
