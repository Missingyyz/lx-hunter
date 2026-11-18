# 音源猎手 Web/Docker 版（v1.9.12）
# 与 PC 桌面版功能一致：爬取 / 沙箱检测 / 灌入 / 巡检 / 导入导出，界面同一套 renderer。
# 零 npm 依赖（仅用 Node 内置模块），镜像无需 npm install，构建不访问外网仓库。
FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=7970 \
    DATA_DIR=/data

WORKDIR /app

# 只拷贝运行所需：core 业务模块 + web 服务端 + renderer 静态资源 + package.json（读版本号）
COPY src ./src
COPY package.json ./package.json
# 评测样本：/api/ai-review/eval-report 读 ../../tests/eval-cases。
# 不带进来时评测恒「无样本」，等于在没有验尺的情况下上线 AI 判定（v1.13.9 修）。
# 只拷这一个数据目录，测试脚本本身（tests/*.js）不进产物。
COPY tests/eval-cases ./tests/eval-cases

# 数据目录（挂载卷）：提前建好并交给非 root 的 node 用户
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 7970

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7970)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server/web.js"]
