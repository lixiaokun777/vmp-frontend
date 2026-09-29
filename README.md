# VMP Frontend

VMP 虚拟机申领平台的前端项目。第一版覆盖资源总览、申请虚拟机、我的虚拟机，以及全部实例、宿主机、镜像、资源规格和网络 IP 等平台管理页面。

## 技术形态

- 原生 HTML/CSS/JavaScript，无构建依赖。
- Nginx 托管静态文件并将 `/api/` 反向代理到后端。
- 数据来自 `/api/v1`，后端不可用时会显示明确错误。

## 目录

```text
web/                 页面、交互和样式
deployments/         Nginx 部署配置
docs/                开发和接口依赖文档
Dockerfile           静态站点镜像
CHANGELOG.md         版本变更记录
```

## 本地预览

```bash
docker build -t vmp-frontend:dev .
docker run --rm -p 8080:80 vmp-frontend:dev
```

开发环境如果后端不在 Docker 网络中，需要将 `deployments/nginx.conf` 的 `proxy_pass` 改为实际控制面地址。

## 文档同步规则

功能、页面入口、API 依赖或部署方式变更时，同一次提交必须更新 `README.md`、`docs/` 中对应文档和 `CHANGELOG.md`。项目内人工编写的注释统一使用中文。
