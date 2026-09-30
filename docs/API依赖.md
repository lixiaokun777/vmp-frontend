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
| LDAP 配置与同步                  | GET/PUT/POST          | `/api/v1/ldap/status`、`/ldap/config`、`/ldap/test`、`/ldap/sync`  |

当接口字段、路径或错误语义变更时，必须同步更新本文档和页面处理逻辑。

业务请求通过 HttpOnly 会话 Cookie 认证，前端不得再发送或信任 `X-User`。普通用户界面只显示申请和本人实例页面，管理接口的最终权限仍由后端校验。

登录请求必须传送 `source=LOCAL` 或 `source=LDAP`。LDAP 配置响应只返回 `has_bind_password`，不得在前端请求、状态或日志中回显已保存的绑定密码。

`POST /api/v1/applications` 成功响应的 `connection` 对象包含 `ip_address`、`username`、`password` 和 `available_after_provisioning`。其中 `password` 只在本次响应中可用，页面不得进行持久化。

实例详情使用 `POST /api/v1/instances/{id}/actions` 的 `reset_password` 动作重新生成一次性密码。响应 `connection.password` 只允许当前弹窗展示和复制，前端不得写入本地存储、URL 或日志；密码在 `RESET_INSTANCE_PASSWORD` 任务成功后生效。

`GET /api/v1/images` 的每个镜像增加 `file_name`，用于平台管理员核对宿主机上的只读基础镜像文件。
