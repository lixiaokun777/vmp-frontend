# API 依赖

| 页面                             | 方法                  | 路径                                                               |
| -------------------------------- | --------------------- | ------------------------------------------------------------------ |
| 登录与当前用户                   | POST/GET              | `/api/v1/auth/login`、`/auth/logout`、`/auth/me`、`/auth/password` |
| 资源总览                         | GET                   | `/api/v1/summary`                                                  |
| 申请虚拟机                       | GET/POST              | `/api/v1/flavors`、`/images`、`/networks`、`/applications`         |
| 我的虚拟机                       | GET                   | `/api/v1/instances?scope=mine`                                     |
| 实例详情                         | GET                   | `/api/v1/instances/{id}`                                           |
| 开机、关机、重启、重试创建、释放 | POST                  | `/api/v1/instances/{id}/actions`                                   |
| 虚拟机续期                       | POST                  | `/api/v1/instances/{id}/renew`                                     |
| 全部实例                         | GET                   | `/api/v1/instances`                                                |
| 宿主机                           | GET/PATCH             | `/api/v1/hosts`、`/hosts/{id}/status`、`/hosts/{id}/quota`         |
| 镜像                             | GET/POST/PATCH        | `/api/v1/images`                                                   |
| 资源规格                         | GET/POST/PATCH        | `/api/v1/flavors`                                                  |
| 网络 IP                          | GET/POST/PATCH        | `/api/v1/networks`、`/networks/{id}/ip-ranges`、`/ip-addresses`    |
| 用户管理                         | GET/POST/PATCH/DELETE | `/api/v1/users`、`/users/{id}/password`                            |
| LDAP 同步                        | GET/POST              | `/api/v1/ldap/status`、`/ldap/sync`                                |

当接口字段、路径或错误语义变更时，必须同步更新本文档和页面处理逻辑。

业务请求通过 HttpOnly 会话 Cookie 认证，前端不得再发送或信任 `X-User`。普通用户界面只显示申请和本人实例页面，管理接口的最终权限仍由后端校验。

`POST /api/v1/applications` 成功响应的 `connection` 对象包含 `ip_address`、`username`、`password` 和 `available_after_provisioning`。其中 `password` 只在本次响应中可用，页面不得进行持久化。

`GET /api/v1/images` 的每个镜像增加 `file_name`，用于平台管理员核对宿主机上的只读基础镜像文件。
