export interface Env {
  IMG_BUCKET: R2Bucket;
  WEBHOOK_DEDUP: KVNamespace;
  GATEWAY_BASE_URL: string;
  SIDECAR_BASE_URL: string;
  DASHBOARD_ORIGIN: string;
  LINE_CHANNEL_SECRET: string;
  LINE_ALLOWED_USER_IDS: string;
  CF_UPLOAD_SECRET: string;
  DASHBOARD_INGEST_TOKEN: string;
  DASHBOARD_TOKEN: string;
}
