# API 依赖

Cookie 登录后的非 GET / HEAD 写请求必须带 `X-VMP-Request: 1`，由后端与同源校验一起验证。统一 `api()` 为 POST / PUT / PATCH / DELETE 自动添加此头；控制台窗口独立领取票据的 `fetch()` 也携带它。不得为跨域页面放开允许该头的任意 Origin，外部网关必须原样转发此头。浏览器原生跨站表单不能设置该自定义头。

前端、后端和 Agent 当前推荐版本均为 `0.6.0`，版本组合和安装步骤见 [完整部署手册](https://github.com/lixiaokun777/vmp-backend/blob/main/docs/部署指南.md)。0.6.0 新增个人概览 `GET /api/v1/me/overview`、实例指标 `GET /api/v1/instances/{id}/metrics`，并扩展申请列表返回结构化任务错误。通知接口为 `GET/PUT /api/v1/notifications/config`、`POST /api/v1/notifications/test`、`GET /api/v1/notifications/events?page=1&status=SENT`，均要求管理员，发送记录每页 20 条；凭据留空保持原值、读取只返回打码信息。测试必须保存配置后执行。

| 页面                             | 方法                  | 路径                                                               |
| -------------------------------- | --------------------- | ------------------------------------------------------------------ |
| 登录与当前用户                   | POST/GET              | `/api/v1/auth/login`、`/auth/logout`、`/auth/me`、`/auth/password` |
| 资源总览                         | GET                   | `/api/v1/summary`                                                  |
| 我的概览                         | GET                   | `/api/v1/me/overview`                                              |
| 申请虚拟机                       | GET/POST              | `/api/v1/flavors`、`/images`、`/networks`、`/applications`         |
| 我的虚拟机                       | GET                   | `/api/v1/instances?scope=mine`                                     |
| 实例详情                         | GET                   | `/api/v1/instances/{id}`                                           |
| 实例近 24 小时指标               | GET                   | `/api/v1/instances/{id}/metrics`                                   |
| 开机、关机、重启、重试创建、释放 | POST                  | `/api/v1/instances/{id}/actions`                                   |
| 虚拟机续期                       | POST                  | `/api/v1/instances/{id}/renew`                                     |
| 保留期实例恢复                   | POST                  | `/api/v1/instances/{id}/restore`                                   |
| 我的申请 / 待我审批              | GET/POST              | `/api/v1/approvals`、`/approvals/{id}/decision`                    |
| 审批撤回、短租期重提、批量处理   | POST                  | `/approvals/{id}/withdraw`、`/resubmit-short`、`/batch-decision`   |
| 全部实例                         | GET                   | `/api/v1/instances`                                                |
| 宿主机                           | GET/PATCH             | `/api/v1/hosts`、`/hosts/{id}/status`、`/hosts/{id}/quota`         |
| 管理员宿主凭据签发 / 轮换        | POST                  | `/api/v1/hosts/{id}/credentials/rotate`                            |
| 镜像                             | GET/POST/PATCH        | `/api/v1/images`                                                   |
| 资源规格                         | GET/POST/PATCH        | `/api/v1/flavors`                                                  |
| 网络 IP                          | GET/POST/PATCH        | `/api/v1/networks`、`/networks/{id}/ip-ranges`、`/ip-addresses`    |
| 隔离 IP 重新探测 / 安全解除       | POST                  | `/api/v1/ip-addresses/{id}/probe`                                 |
| 每网络批量复核隔离 IP            | POST                  | `/api/v1/networks/{id}/probe-quarantined`                          |
| 用户管理                         | GET/POST/PATCH/DELETE | `/api/v1/users`、`/users/{id}/password`                            |
| LDAP 配置与同步                  | GET/PUT/POST          | `/api/v1/ldap/status`、`/ldap/config`、`/ldap/test`、`/ldap/sync`  |
| 操作审计                         | GET                   | `/api/v1/audit-logs`                                             |
| VNC / 串口控制台               | POST                  | `/api/v1/instances/{id}/console-sessions`                        |
| 平台公平使用 / 历史保留策略 | GET/PUT | `/api/v1/platform-policy` |
| 实例有限自动续期 | GET/PUT | `/api/v1/instances/{id}/auto-renew` |
| 审批代理 / 转交 | GET/PUT/POST | `/api/v1/approval-delegation`、`/approvals/{id}/transfer` |
| 定向镜像同步 | POST | `/api/v1/images/{id}/sync` |
| 历史归档 / 下载 / 清理 | GET/POST/DELETE | `/api/v1/history/archives`、`/{id}/download`、`/{id}/purge` |

当接口字段、路径或错误语义变更时，必须同步更新本文档和页面处理逻辑。

## 隔离 IP 复核与失败实例恢复

本节依赖配套的新后端 / Agent 探测协议，不能只刷新旧固定版本。所有复核写接口要求管理员 Cookie 与 `X-VMP-Request: 1`。

- 单地址 POST `{release_if_free:false}` 只更新探测结果，不改变隔离状态；`true` 仅在探测成功为 FREE 且仍为无实例关联的 QUARANTINED 时解除。返回 HTTP 202 `{task_id,ip_address,probe_pending:true,already_pending?,message}`。已有任务不会因重复提交而升级为解除操作，必须显示服务器实际 message。
- 每网络 POST `{release_if_free:true,limit:32}`，limit 为 1–64 的整数，默认 32。HTTP 202 返回 `{queued,skipped,limit,max_limit:64,remaining,confirmed_in_use,task_ids,message}`。remaining 只统计 UNKNOWN / ERROR 的尚未复核或异常待查地址；confirmed_in_use 是已确认占用且仍保持隔离的数量。排队不等于已经解除；页面分别显示限批、待查和占用数量，不静默假称已处理全部隔离地址。
- IP 行新增 `last_probe_status=UNKNOWN|PENDING|FREE|IN_USE|ERROR`、`last_probe_at`、`last_probe_message`、`last_probe_host_id`、`last_probe_host` 与 `probe_pending`。动态说明、宿主和 ID 一律编码；只有管理员且地址为 QUARANTINED、无 instance_id、无 pending 时显示操作。已分配 / 预留 / 保留期关联地址没有解除入口。
- 实例 `retry` 无 FREE 地址但存在可复核隔离地址时返回 `{status:"ERROR",recovery_pending:true,task_id,message}`，不是已经创建。详情 / 列表新增 `ip_recovery_pending/ip_recovery_message/ip_recovery_task_id`，关联 PROBE 任务进入实例任务历史。页面复核中禁重复 retry，按真实 message 显示；成功后后端自动继续原 CREATE，生命周期进入 PROVISIONING。

网络页每 10 秒只更新结果和网络计数卡片；筛选表单不销毁，弹窗 / 执行中操作 / 中文输入期间暂停。局部返回校验会话、导航、局部刷新代际，不能回写新账号或新页面。浏览器取消请求不等于撤销已经排队的探测任务。

“平台保留 IP”仅是平台账本，不是外部 DHCP 租约锁。管理员必须把平台地址范围从 DHCP 动态池排除；恢复 / 开机前再次检查冲突，不能以数据库空闲直接跳过探测。

## 宿主凭据页面管理（前端 0.5.2）

`GET /api/v1/hosts` 新增 `credential_status=MISSING/ACTIVE/REVOKED`、`credential_generation` 和 `credential_updated_at`，只返回元数据，不返回令牌或令牌摘要。字段缺失的旧后端在页面显示“凭据状态未上报”，仍可使用既有轮换接口；有效凭据不等于宿主在线或交付就绪。

管理员页面确认目标名称 / UUID / 管理 IP，明确停止目标 Agent 并排空在途任务后，调用轮换接口，JSON 请求体为 `{}`。成功返回 `host_id`、`runtime_token`、`generation`、`status`；旧值立即失效，宿主暂停调度，不操作实例或自动恢复写模式。界面只在本次弹窗显示令牌，独立复制两项或两行导入片段，要求确认已保存。未保存离开时提示；关闭、退出、会话切换及 pagehide 清空一次性持有对象，不使用浏览器持久存储、不写日志。网络中断或异常响应不能假报成功，需保持宿主暂停并核对后重新签发。

该接口要求已完成首登改密的管理员 Cookie 会话及 `X-VMP-Request: 1`，普通用户无入口且后端拒绝。此次仅加页面和安全元数据，无新迁移、不改变 Agent 协议。新页面由前端 `0.5.2` 提供，旧前端 `0.5.1` 镜像不含该入口。

业务请求通过 HttpOnly 会话 Cookie 认证，前端不得再发送或信任 `X-User`。普通用户界面只显示申请、本人实例和本人审批记录，管理接口的最终权限仍由后端校验。

登录请求必须传送 `source=LOCAL` 或 `source=LDAP`。LDAP 配置响应只返回 `has_bind_password`，不得在前端请求、状态或日志中回显已保存的绑定密码。

`POST /api/v1/applications` 成功响应的 `connection` 对象包含 `ip_address`、`username`、`password` 和 `available_after_provisioning`。其中 `password` 只在本次响应中可用，页面不得进行持久化。

实例详情使用 `POST /api/v1/instances/{id}/actions` 的 `reset_password` 动作重新生成一次性密码。响应 `connection.password` 只允许当前弹窗展示和复制，前端不得写入本地存储、URL 或日志；密码在 `RESET_INSTANCE_PASSWORD` 任务成功后生效。

`GET /api/v1/images` 的每个镜像增加 `file_name`，用于平台管理员核对宿主机上的只读基础镜像文件。

控制台窗口调用同源 `POST /api/v1/instances/{id}/console-sessions`，响应 `websocket_url` 是相对 `/api/v1/console/{mode}?ticket=...`。前端按平台协议转换为 ws/wss，并严格验证同一 host/port 与模式路径；不再允许浏览器直连任意 Agent。票据只在窗口内存中使用，不写入 URL、存储或日志；旧 hash 的 `ws` 移除，重新连接重新申请。后端通过同源桥接访问 Agent。

实例列表与详情应返回 `flavor_id` 和 `resource_snapshot: {cpu, memory_mb, disk_gb}`；列表的 `flavor` 是分配时名称。前端按 ID 聚合占用、按快照展示实际资源，不能用当前可编辑的套餐值回填历史实例。

用户字段 `enabled` 代表管理员平台停用，`ldap_directory_present` 代表最近同步时目录是否仍返回该账号。LDAP 用户目录不可用时前端独立显示提示，不能在编辑表单或前端状态里把它自动改成 `enabled=false`。

## 0.5.1 分页与聚合约定

用户、实例、审批和 IP 列表均返回 `{items,total,page,page_size}`，`page_size` 上限 100。前端不再先拉全量后切片；服务器负责关键词、过滤和页数纠正。

- 用户：`keyword`（用户名/显示名/邮箱）、`role`、`source`、`status=ENABLED|DISABLED|DIRECTORY_UNAVAILABLE|MUST_CHANGE_PASSWORD`。
- 实例：`scope=mine`、`keyword`（名称/使用人/IP）、全部生命周期 `status`、`host_id`。响应额外 `expiring_total` 是全 scope 未来 24 小时到期总数，不受筛选和分页影响。
- 审批：`scope=mine`、`keyword`、`status`、`type=CREATE|RENEW|RESTORE`；记录展示 `assigned_reviewer`、`delegated_from`。
- IP：`network_id`、`keyword`、`status=FREE|ALLOCATED|RESERVED|QUARANTINED`；行返回 `owner/lifecycle_status/allocated_at/reserved_at`，不以相同 IP 地址猜所属实例。
- 管理员规格响应 `usage{running,retained,active,memory_mb,disk_gb,percent}` 按规格 ID 与实例分配快照汇总。首页 / LDAP 数量 / 审批徽标使用服务端 total，不能用当前页行数代替。
- CSV 固定开始导出时的筛选，以 100 条逐页取完整结果；超过 10000 条明确拒绝并要求缩小筛选，不静默截断。CSV 不是数据库事务快照，合规备份使用不可变归档流程。

## 镜像、代理与治理

镜像返回 `generation/desired_enabled/host_readiness[{host_id,host_name,status,error,verified_at,generation}]`。READY 不代表所有宿主可用；显示各宿主实际记录。同步 POST 必须明确选择 1–128 个 `host_ids`，不隐式同步整个资源池。

平台策略字段：`max_instances/max_cpu/max_memory_mb/max_disk_gb/max_future_lease_hours/max_continuous_lease_hours` 的 0 表示不限制；`auto_renew_enabled/auto_renew_hours/auto_renew_max_count` 限制实例自动续期；`audit_retention_days/notification_retention_days/approval_retention_days` 的 0 表示永久保留。额度与审批规则由服务器事务强制执行。

实例自动续期 GET 除配置外返回 `platform_enabled/platform_max_count/platform_max_hours`；普通用户无需访问管理员策略接口。PUT `{enabled,hours,max_renewals}`，UI 显示 `renewed_count/last_error`。

审批代理 GET `{delegation,administrators}`，PUT `{delegate_username,starts_at,ends_at}`，空用户名取消代理；最长 90 天，后端禁止不可用、链式或重叠代理。转交 POST `{reviewer_username,reason}`，只能对有效待处理审批执行。

历史归档 POST `{category:audit|notifications|approvals}`，每批最多 5000 条；GET 列表供下载 gzip NDJSON。下载支持 WebCrypto SHA-256 校验，普通 HTTP 环境需用户自行校验。清理要求已下载并粘贴完整校验和及 `confirm="已下载并校验归档"`；删除归档还要求源记录已清理、有独立备份及 `confirm="已备份归档"`。清理源记录不可撤销，前端不自动替用户确认备份。

通知配置新增 `notify_approvals/notify_failures/notify_host_alerts`；新事件标签涵盖待审批、审批执行失败、交付失败、宿主离线与恢复。均使用已保存机器人配置，页面不会自动发群测试消息。
