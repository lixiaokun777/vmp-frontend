# API 依赖

| 页面 | 方法 | 路径 |
| --- | --- | --- |
| 资源总览 | GET | `/api/v1/summary` |
| 申请虚拟机 | GET/POST | `/api/v1/flavors`、`/images`、`/networks`、`/applications` |
| 我的虚拟机 | GET | `/api/v1/instances?scope=mine` |
| 全部实例 | GET | `/api/v1/instances` |
| 宿主机 | GET/PATCH | `/api/v1/hosts`、`/hosts/{id}/status` |
| 镜像 | GET/POST/PATCH | `/api/v1/images` |
| 资源规格 | GET/POST/PATCH | `/api/v1/flavors` |
| 网络 IP | GET | `/api/v1/networks`、`/ip-addresses` |

当接口字段、路径或错误语义变更时，必须同步更新本文档和页面处理逻辑。
