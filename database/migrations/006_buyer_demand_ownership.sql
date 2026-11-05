ALTER TABLE demands
  ADD COLUMN IF NOT EXISTS buyer_user_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS demands_buyer_user_created_idx
  ON demands(buyer_user_id, created_at DESC, id DESC)
  WHERE buyer_user_id IS NOT NULL;
