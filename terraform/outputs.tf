output "public_ipv4" {
  description = "Server public IPv4"
  value       = hcloud_server.app.ipv4_address
}

output "url" {
  description = "Application URL"
  value       = var.domain != "" ? "https://${var.domain}" : "http://${hcloud_server.app.ipv4_address}"
}

output "ssh_command" {
  description = "SSH into the server"
  value       = "ssh root@${hcloud_server.app.ipv4_address}"
}

output "server_id" {
  description = "Hetzner server ID"
  value       = hcloud_server.app.id
}
