-- AgentRecall Dashboard Tables
CREATE TABLE IF NOT EXISTS ar_awareness (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL UNIQUE,
  evidence TEXT,
  applies_when TEXT[],
  confirmations INTEGER DEFAULT 1,
  trend TEXT DEFAULT 'stable',
  source TEXT,
  source_project TEXT,
  last_confirmed DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ar_corrections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project TEXT NOT NULL,
  severity TEXT DEFAULT 'p1',
  rule TEXT NOT NULL,
  context TEXT,
  goal TEXT,
  delta TEXT,
  correction_date DATE,
  dismissed BOOLEAN DEFAULT false,
  promoted BOOLEAN DEFAULT false,
  source_file TEXT UNIQUE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ar_palace_rooms (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project TEXT NOT NULL,
  room_slug TEXT NOT NULL,
  room_name TEXT,
  description TEXT,
  salience REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
  last_accessed DATE,
  content TEXT,
  is_archived BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project, room_slug)
);

CREATE TABLE IF NOT EXISTS ar_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project TEXT NOT NULL,
  status TEXT DEFAULT 'completed',
  model TEXT,
  phase TEXT,
  summary TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  corrections_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS _backups (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  table_name TEXT NOT NULL,
  original_id UUID,
  data JSONB NOT NULL,
  deleted_at TIMESTAMPTZ DEFAULT now(),
  restored BOOLEAN DEFAULT false
);
