# Kollekta — per-subdomain vhost (Μέρος Α / nginx step)
# Placeholders: {{SUBDOMAIN}} {{PORT}} {{SSL_FULLCHAIN}} {{SSL_PRIVKEY}} {{SECURITY_SNIPPET}}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name {{SUBDOMAIN}}.kollekta.gr;

    ssl_certificate     {{SSL_FULLCHAIN}};
    ssl_certificate_key {{SSL_PRIVKEY}};

    include {{SECURITY_SNIPPET}};

    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:{{PORT}};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name {{SUBDOMAIN}}.kollekta.gr;
    return 301 https://$host$request_uri;
}
