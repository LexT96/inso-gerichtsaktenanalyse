# ─── SSH Keys (lookup pre-registered keys) ───
data "hcloud_ssh_keys" "deploy" {
  with_selector = length(var.ssh_key_names) > 0 ? null : null
}

data "hcloud_ssh_key" "selected" {
  for_each = toset(var.ssh_key_names)
  name     = each.value
}

# ─── Firewall ───
resource "hcloud_firewall" "app" {
  name   = "${var.server_name}-fw"
  labels = var.labels

  rule {
    description = "SSH"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.ssh_source_ips
  }

  rule {
    description = "HTTP"
    direction   = "in"
    protocol    = "tcp"
    port        = "80"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS TCP"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }

  rule {
    description = "HTTPS UDP (HTTP/3)"
    direction   = "in"
    protocol    = "udp"
    port        = "443"
    source_ips  = ["0.0.0.0/0", "::/0"]
  }
}

# ─── Server ───
resource "hcloud_server" "app" {
  name        = var.server_name
  server_type = var.server_type
  location    = var.server_location
  image       = "ubuntu-24.04"
  labels      = var.labels

  ssh_keys = [for k in data.hcloud_ssh_key.selected : k.id]

  firewall_ids = [hcloud_firewall.app.id]

  user_data = templatefile("${path.module}/cloud-init.yaml", {
    domain                 = var.domain
    anthropic_api_key      = var.anthropic_api_key
    anthropic_base_url     = var.anthropic_base_url
    extraction_provider    = var.extraction_provider
    extraction_model       = var.extraction_model
    utility_model          = var.utility_model
    openai_api_key         = var.openai_api_key
    openai_model           = var.openai_model
    openai_base_url        = var.openai_base_url
    openai_reasoning_effort = var.openai_reasoning_effort
    jwt_secret             = var.jwt_secret
    admin_password         = var.admin_password
    db_encryption_key      = var.db_encryption_key
    git_repo_url           = var.git_repo_url
    git_branch             = var.git_branch
    setup_script_b64       = base64encode(file("${path.module}/setup.sh"))
  })

  lifecycle {
    ignore_changes = [user_data]
  }
}
