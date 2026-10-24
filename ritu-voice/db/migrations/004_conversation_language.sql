-- Per-conversation WhatsApp language (ISO code like 'kn-IN'), so inbound
-- replies, reminders, and followups match the language the patient booked in.
-- Seeded from the call's language at confirmation; refined by inbound-text
-- script detection. Additive — NULL means "not yet known → default Hindi".
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS language TEXT;
