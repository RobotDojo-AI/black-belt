-- 005_key_documents.sql
-- Timeline pipeline: key documents, receipts, and person-month address timeline.
-- Documents are tier-1 ground truth; receipts are tier-2 deterministic;
-- address_timeline is the compiled output of the signal hierarchy.

CREATE TABLE IF NOT EXISTS key_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,                              -- email id, file path, attachment uri
  source_type TEXT NOT NULL,                   -- 'email' | 'drive' | 'upload' | 'attachment'
  doc_type TEXT NOT NULL,                      -- documents.yaml enum
  extracted_json TEXT NOT NULL,                -- structured fields per per-type contract
  owner_person_id TEXT,                        -- FK people.id (TEXT)
  document_date TEXT,                          -- date on the document (tax year, bill period, etc.)
  received_at TEXT,                            -- when Robot Dojo saw it
  extraction_confidence REAL,
  extraction_model TEXT,                       -- which LLM did extraction
  raw_text_hash TEXT NOT NULL,                 -- SHA-256 of source text (dedup key)
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_person_id) REFERENCES people(id)
);

CREATE INDEX IF NOT EXISTS idx_key_documents_owner ON key_documents(owner_person_id);
CREATE INDEX IF NOT EXISTS idx_key_documents_type ON key_documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_key_documents_date ON key_documents(document_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_key_documents_hash ON key_documents(raw_text_hash);

CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  source_type TEXT NOT NULL,                   -- 'email' | 'attachment' | 'upload' | 'platform_api'
  category TEXT NOT NULL,                      -- receipts.yaml enum
  merchant TEXT,
  platform TEXT,
  purchase_date TEXT,
  amount_cents INTEGER,
  currency TEXT DEFAULT 'USD',
  delivery_address_json TEXT,                  -- structured address (pre-normalization)
  billing_address_json TEXT,
  items_json TEXT,                             -- line items
  is_gift INTEGER DEFAULT 0,
  owner_person_id TEXT,                        -- FK people.id
  extraction_confidence REAL,
  extraction_model TEXT,
  raw_text_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_person_id) REFERENCES people(id)
);

CREATE INDEX IF NOT EXISTS idx_receipts_owner ON receipts(owner_person_id);
CREATE INDEX IF NOT EXISTS idx_receipts_category ON receipts(category);
CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(purchase_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_hash ON receipts(raw_text_hash);

CREATE TABLE IF NOT EXISTS address_timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL,                     -- FK people.id
  address_normalized TEXT NOT NULL,            -- normalized string: "123 MAIN ST, SPRINGFIELD, IL 62704"
  address_json TEXT NOT NULL,                  -- {line1, line2, city, region, postal_code, country, formatted}
  month_start TEXT NOT NULL,                   -- YYYY-MM-01
  residency_type TEXT,                         -- addresses.yaml enum
  dominant_source TEXT NOT NULL,               -- 'document' | 'receipt' | 'calendar' | 'contact' | 'email' | 'sms'
  source_count INTEGER DEFAULT 1,              -- number of signals in this person-month-address cluster
  confidence REAL NOT NULL,                    -- weighted combination
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (person_id) REFERENCES people(id),
  UNIQUE(person_id, month_start, address_normalized)
);

CREATE INDEX IF NOT EXISTS idx_address_timeline_person ON address_timeline(person_id);
CREATE INDEX IF NOT EXISTS idx_address_timeline_month ON address_timeline(month_start);
CREATE INDEX IF NOT EXISTS idx_address_timeline_residency ON address_timeline(residency_type);
