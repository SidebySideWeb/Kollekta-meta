/**
 * Shared plan catalog for meta-admin provisioning + UI previews.
 * Feature defaults mirror Product-imageshare/config.js (pro+ = pro|business).
 * Quota GB / warn % are written into each instance's prod.env as QUOTA_*.
 */

const PLANS = ['basic', 'pro', 'business'];

const PLAN_ANNUAL_PRICE_EUR = {
  basic: 300,
  pro: 600,
  business: 1100,
};

/** Host-facing packaging per plan (provisioned into prod.env). */
const PLAN_CATALOG = {
  basic: {
    id: 'basic',
    label: 'Basic',
    quotaGb: 10,
    quotaWarnPercent: 75,
    retentionMonths: 12,
    annualPriceEur: PLAN_ANNUAL_PRICE_EUR.basic,
    features: {
      productCodes: false,
      orderFiltering: false,
      tags: false,
      retentionOverride: false,
    },
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    quotaGb: 25,
    quotaWarnPercent: 75,
    retentionMonths: 24,
    annualPriceEur: PLAN_ANNUAL_PRICE_EUR.pro,
    features: {
      productCodes: true,
      orderFiltering: true,
      tags: true,
      retentionOverride: true,
    },
  },
  business: {
    id: 'business',
    label: 'Business',
    quotaGb: 60,
    quotaWarnPercent: 75,
    retentionMonths: null,
    annualPriceEur: PLAN_ANNUAL_PRICE_EUR.business,
    features: {
      productCodes: true,
      orderFiltering: true,
      tags: true,
      retentionOverride: true,
    },
  },
};

function isValidPlan(plan) {
  return PLANS.includes(String(plan || '').trim().toLowerCase());
}

function getPlan(plan) {
  const key = String(plan || '').trim().toLowerCase();
  return PLAN_CATALOG[key] || null;
}

function defaultPriceForPlan(plan) {
  const entry = getPlan(plan);
  return entry ? entry.annualPriceEur : null;
}

/**
 * Env vars derived from the plan for prod.env.
 * Keep in sync with the M3 form preview (listPlansPublic).
 */
function planEnvFlags(plan) {
  const entry = getPlan(plan);
  if (!entry) return null;
  const f = entry.features;
  return {
    PLAN: entry.id,
    QUOTA_GB: String(entry.quotaGb),
    QUOTA_WARN_PERCENT: String(entry.quotaWarnPercent),
    // Main app currently reads STORAGE_WARN_PERCENT — keep both aligned.
    STORAGE_WARN_PERCENT: String(entry.quotaWarnPercent),
    DEFAULT_RETENTION_MONTHS:
      entry.retentionMonths == null ? 'null' : String(entry.retentionMonths),
    FEATURE_PRODUCT_CODES: f.productCodes ? 'true' : 'false',
    FEATURE_ORDER_FILTERING: f.orderFiltering ? 'true' : 'false',
    FEATURE_TAGS: f.tags ? 'true' : 'false',
    FEATURE_RETENTION_OVERRIDE: f.retentionOverride ? 'true' : 'false',
  };
}

function listPlansPublic() {
  return PLANS.map((id) => {
    const p = PLAN_CATALOG[id];
    return {
      id: p.id,
      label: p.label,
      quotaGb: p.quotaGb,
      quotaWarnPercent: p.quotaWarnPercent,
      retentionMonths: p.retentionMonths,
      annualPriceEur: p.annualPriceEur,
      features: { ...p.features },
    };
  });
}

module.exports = {
  PLANS,
  PLAN_ANNUAL_PRICE_EUR,
  PLAN_CATALOG,
  isValidPlan,
  getPlan,
  defaultPriceForPlan,
  planEnvFlags,
  listPlansPublic,
};
