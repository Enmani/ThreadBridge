# Security

ThreadBridge processes private conversation history. Keep the database, session files, exports and browser profile on a trusted machine. The dashboard listens on loopback and rejects foreign hosts/origins; it is not designed for exposure through a public proxy.

For a security report, use GitHub's **Report a vulnerability** option if available. Otherwise, open an issue asking for a private reporting channel without including exploit details or private data. Never submit credentials or conversation contents.

The Codex native adapter and ChatGPT browser endpoints are internal interfaces. Their compatibility can change independently of this project.

Model connections are separate from browser login. Optional cloud generation sends bounded chat data to the user's selected HTTPS service; local generation uses loopback only. Keys are encrypted using Windows CurrentUser DPAPI or AES-GCM with a private 0600 key beside the database on other systems. Protect both the database and key file; never publish either. URLs cannot contain credentials or query strings, redirects are rejected, and provider error bodies are not exposed. Existing MCP clients keep their own authentication and choose their own model.
