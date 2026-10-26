# Railway: production build of the Next.js app. Build context: the repo root.
# NEXT_PUBLIC_API_URL (the backend's public https URL) is baked in at build time, so set it as a
# service variable BEFORE the first build, and redeploy after changing it.
FROM node:22-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
# next start reads PORT, which Railway sets.
CMD ["npm", "start"]
