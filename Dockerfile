ARG NGINX_IMAGE=nginx:1.30.5-alpine

FROM ${NGINX_IMAGE}

COPY web/ /usr/share/nginx/html/
COPY deployments/nginx.conf /etc/nginx/conf.d/default.conf
