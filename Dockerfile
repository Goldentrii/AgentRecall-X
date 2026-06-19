FROM node:20-slim
WORKDIR /app
COPY package*.json ./
COPY packages/mcp-server/package*.json ./packages/mcp-server/
COPY packages/core/package*.json ./packages/core/
COPY tsconfig.base.json ./
RUN npm install --workspaces --if-present
COPY packages/ ./packages/
RUN npm run build --workspace=packages/mcp-server
ENV NODE_ENV=production
CMD ["node", "packages/mcp-server/dist/index.js"]
