# Static site served by Nginx. No build step: the app is plain HTML/CSS/JS.
FROM nginx:1.27-alpine

# Replace the default server config with ours.
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Copy the static assets into the web root.
COPY index.html app.js styles.css favicon.svg /usr/share/nginx/html/
COPY docs/ /usr/share/nginx/html/docs/

EXPOSE 80

# Validate the Nginx config at build time.
RUN nginx -t

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost:80/healthz || exit 1
