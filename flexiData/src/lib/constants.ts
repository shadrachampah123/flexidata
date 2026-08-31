export type Network = "MTN" | "TELECEL";

export const NETWORKS: { id: Network; label: string; dot: string }[] = [
  { id: "MTN", label: "MTN", dot: "#FFCB05" },
  { id: "TELECEL", label: "Telecel", dot: "#F04438" },
];

export type BundleCategory = {
  id: string;
  network: Network;
  label: string;
  hint: string;
};

export const BUNDLE_CATEGORIES: BundleCategory[] = [
  { id: "up2u", network: "MTN", label: "MTN UP2U Bundles", hint: "Flexible everyday bundles" },
  { id: "sme", network: "MTN", label: "SME Data", hint: "Non-expiry business value" },
  { id: "corporate", network: "MTN", label: "Corporate Gifting", hint: "Bulk gifting rates" },
  { id: "social", network: "MTN", label: "Social Bundles", hint: "WhatsApp, TikTok, X & more" },
  { id: "tdata", network: "TELECEL", label: "Telecel Data", hint: "Red everyday bundles" },
  { id: "just4u", network: "TELECEL", label: "Just4U Offers", hint: "Personalised red deals" },
  { id: "gifting", network: "TELECEL", label: "Telecel Gifting", hint: "Send data as a gift" },
];

export type RedeemOption = {
  id: string;
  kind: "cash" | "airtime" | "data";
  label: string;
  cost: number;
  amount: number;
};

export const REDEEM_OPTIONS: RedeemOption[] = [
  { id: "cash2", kind: "cash", label: "GH₵ 2 wallet cash", cost: 120, amount: 2 },
  { id: "air5", kind: "airtime", label: "GH₵ 5 airtime", cost: 300, amount: 5 },
  { id: "data1", kind: "data", label: "1GB MTN data", cost: 480, amount: 1 },
  { id: "cash10", kind: "cash", label: "GH₵ 10 wallet cash", cost: 560, amount: 10 },
  { id: "air15", kind: "airtime", label: "GH₵ 15 airtime", cost: 830, amount: 15 },
  { id: "cash25", kind: "cash", label: "GH₵ 25 wallet cash", cost: 1300, amount: 25 },
];

export type Contact = { name: string; phone: string };

export const CONTACTS: Contact[] = [
  { name: "Ama Serwaa", phone: "0244123456" },
  { name: "Kofi Mensah", phone: "0501234567" },
  { name: "Efua Boateng", phone: "0556789012" },
  { name: "Yaw Darko", phone: "0209876543" },
  { name: "Adjoa Anan", phone: "0273456789" },
  { name: "Kwabena Osei", phone: "0591112223" },
];

export const POINTS_RATE = 2; // points earned per GH₵ spent
export const AIRTIME_DISCOUNT = 0.02; // 2% off airtime purchases

export function conversionFeeRate(amount: number): number {
  return amount >= 200 ? 0.1 : 0.12;
}

export type AgentTier = {
  name: string;
  minReferrals: number;
  wholesale: string;
  commission: string;
  blurb: string;
};

export const AGENT_TIERS: AgentTier[] = [
  {
    name: "Starter",
    minReferrals: 0,
    wholesale: "5% below retail",
    commission: "3% referral commission",
    blurb: "Instant activation, standard wholesale rates",
  },
  {
    name: "Pro",
    minReferrals: 5,
    wholesale: "9% below retail",
    commission: "5% referral commission",
    blurb: "Priority support & early promo access",
  },
  {
    name: "Elite",
    minReferrals: 20,
    wholesale: "14% below retail",
    commission: "8% referral commission",
    blurb: "Dedicated account manager & float credit",
  },
];

export const APP_NAME = "QuickVend";
export const APP_TAGLINE = "Data & airtime, instantly.";
