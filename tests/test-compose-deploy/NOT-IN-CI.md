# 不进 CI 的理由 —— 本套件以「宿主机 docker compose」本身为被测对象
#
# 它要在执行器上 build 两个镜像、起真实容器、做迁移演练（stop → tar → 换目录 →
# up），需要：嵌套 docker（或宿主 sock）+ compose v2 + 3~5 分钟构建窗口 +
# 19200/13000 空闲端口。现有 qa.yml / e2e-docker.yml 各 job 没有这个执行器，
# 硬塞进去只会得到一个要么超时、要么 SKIP 的假绿。
#
# 本地按 AGENTS.md 手动执行，结果存 docs/tests/：
#   bash tests/test-compose-deploy/run.sh 2>&1 | tee docs/tests/report-test-compose-deploy.txt

Verified: 2026-10-08
Revisit-when: CI 出现「带宿主 docker sock + compose v2 + 空闲高端口」的执行器（如 e2e-docker.yml 扩出 compose job）时，把目录名加进 scripts/qa.sh 或 workflow 并撤掉本文件
