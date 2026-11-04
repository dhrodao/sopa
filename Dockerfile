# Static site served by Nginx. No build step: the app is plain HTML/CSS/JS.
FROM nginx:1.27-alpine

# Replace the default server config with ours.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Copy the static assets into the web root.
COPY index.html app.js styles.css favicon.svg /usr/share/nginx/html/
COPY docs/ /usr/share/nginx/html/docs/

EXPOSE 443

# Note: `nginx -t` is NOT run at build time because the TLS cert/key are
# mounted as a volume at runtime (deploy/certs) and are absent during build.

# Health check over HTTPS (self-reachable; --no-check-certificate because the
# Origin CA cert is for the public hostname, not "localhost").
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- --no-check-certificate https://localhost:443/healthz || exit 1
