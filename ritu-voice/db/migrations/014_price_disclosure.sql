-- ═══════════════════════════════════════════════════════════════════════════
-- 014 — SOME PRICES ARE NOT SAID OUT LOUD.
--
-- Skin Essence's setup form has a "Tell price on call?" column, and for two of
-- its five treatments the answer is NO: wart removal (₹1,500–5,000) and tattoo
-- removal (₹1,500–3,000). Both depend on the number, size and age of what is
-- being treated, so a range quoted down the phone becomes an argument at the
-- desk. The doctor quotes after examining.
--
-- The clinic still needs those numbers on the desk for its own staff, so the
-- row keeps them. What changes is whether they reach the MODEL: when
-- disclose_price is false, db.getTreatments renders "price: doctor dekh kar
-- batayenge" and the digits are never concatenated into the prompt at all.
-- Suppression at the point of RENDER, not by instructing the model to keep a
-- secret it can see — a prompt line asking the model not to repeat a number it
-- was shown is the kind of instruction medicalAdviceGuard.js exists because of.
--
-- DEFAULT FALSE, BACKFILLED TRUE. A new row somebody forgets to flag is silent
-- about price, which is recoverable — the caller is told the doctor will
-- confirm. The other default is a price quoted that the clinic never agreed to
-- say. Existing rows are set TRUE in the same statement so every clinic already
-- running keeps its behaviour byte-for-byte.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE treatments
  ADD COLUMN IF NOT EXISTS disclose_price BOOLEAN NOT NULL DEFAULT FALSE;

-- Rows that existed before this column did were all being quoted. Keep them so.
UPDATE treatments SET disclose_price = TRUE WHERE disclose_price = FALSE;
