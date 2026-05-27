export const PLANS = {
  FREE: {
    id: 'free',
    name: 'Free',
    credits: 30, // 30 min por mês grátis
    price: 0,
    max_clip_duration: 300, // 5 min
    max_upload_size_mb: 50,
    max_source_duration: 600, // 10 min
    export_quality: '720p',
    subtitle_styles_limit: 5,
    has_watermark: true,
    concurrent_jobs: 1,
    available_integrations: [],
  },
  START: {
    id: 'start',
    name: 'Start',
    credits: 150,
    price: 19.90,
    max_clip_duration: 900, // 15 min
    max_upload_size_mb: 200,
    max_source_duration: 3600, // 1 hora
    export_quality: '1080p',
    subtitle_styles_limit: 20,
    has_watermark: false,
    concurrent_jobs: 3,
    available_integrations: ['youtube', 'tiktok'],
  },
  PRO: {
    id: 'pro',
    name: 'Pro',
    credits: 300,
    price: 39.90,
    max_clip_duration: 7200, // 2 horas
    max_upload_size_mb: 1024,
    max_source_duration: 10800, // 3 horas
    export_quality: '4k',
    subtitle_styles_limit: 1000,
    has_watermark: false,
    concurrent_jobs: 10,
    available_integrations: ['youtube', 'tiktok', 'instagram', 'facebook'],
  },
  CUSTOM: {
    id: 'custom',
    name: 'Consultar',
    credits: 0,
    price: 0,
    max_clip_duration: 99999,
    max_upload_size_mb: 99999,
    max_source_duration: 99999,
    export_quality: '4k',
    subtitle_styles_limit: 1000,
    has_watermark: false,
    concurrent_jobs: 10,
    available_integrations: ['youtube', 'tiktok', 'instagram', 'facebook'],
  },
};

export const EXTRA_CREDITS = [
  { amount: 25, price: 5.00 },
  { amount: 50, price: 10.00 },
  { amount: 75, price: 15.00 },
];
