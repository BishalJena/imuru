# Reference MCP server from the MCP project, pinned, served over Streamable HTTP.
FROM node:22.23.3-alpine3.24
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund @modelcontextprotocol/server-everything@2026.8.31 \
 && npm cache clean --force
USER node
ENV PORT=3001
EXPOSE 3001
CMD ["node", "node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
