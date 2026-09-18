const express = require('express');
const path = require('path');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database('database.sqlite');

// Inicializar tablas
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    alias TEXT,
    passes INTEGER NOT NULL DEFAULT 1,
    phone TEXT,
    status TEXT DEFAULT 'pendiente', -- 'pendiente', 'confirmado', 'rechazado'
    confirmed_passes INTEGER DEFAULT 0,
    guest_phone TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME
  );
`);

const getInitialCapacity = db.prepare("SELECT value FROM config WHERE key = 'total_capacity'").get();
if (!getInitialCapacity) {
  db.prepare("INSERT INTO config (key, value) VALUES ('total_capacity', '100')").run();
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function generateUniqueCode(firstName) {
  const cleanName = firstName.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  const randomStr = crypto.randomBytes(3).toString('hex');
  return `${cleanName || 'inv'}-${randomStr}`;
}

// ---------------- API RUTAS ----------------

// Dashboard con métricas de pases
app.get('/api/dashboard', (req, res) => {
  const capacityRow = db.prepare("SELECT value FROM config WHERE key = 'total_capacity'").get();
  const totalCapacity = parseInt(capacityRow ? capacityRow.value : '100', 10);

  const guests = db.prepare("SELECT * FROM guests ORDER BY id DESC").all();

  let confirmedGuests = 0;
  let rejectedGuests = 0;
  let pendingGuests = 0;
  let occupiedPasses = 0;
  let assignedPasses = 0;

  guests.forEach(g => {
    assignedPasses += g.passes;
    if (g.status === 'confirmado') {
      confirmedGuests++;
      occupiedPasses += g.confirmed_passes;
    } else if (g.status === 'rechazado') {
      rejectedGuests++;
    } else {
      pendingGuests++;
    }
  });

  res.json({
    totalCapacity,
    assignedPasses,
    occupiedPasses,
    remainingPasses: Math.max(0, totalCapacity - occupiedPasses),
    confirmedGuests,
    rejectedGuests,
    pendingGuests,
    totalGuests: guests.length,
    guests
  });
});

// Guardar Pases Totales del Evento
app.post('/api/config/capacity', (req, res) => {
  const { capacity } = req.body;
  if (!capacity || isNaN(capacity) || capacity < 1) {
    return res.status(400).json({ error: 'Número de pases no válido' });
  }
  db.prepare("UPDATE config SET value = ? WHERE key = 'total_capacity'").run(capacity.toString());
  res.json({ success: true, capacity });
});

// Registrar nuevo invitado
app.post('/api/guests', (req, res) => {
  const { first_name, last_name, alias, passes, phone } = req.body;

  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'Nombre y apellido son requeridos.' });
  }

  const passCount = parseInt(passes, 10) || 1;
  const code = generateUniqueCode(first_name);

  try {
    const stmt = db.prepare(`
      INSERT INTO guests (code, first_name, last_name, alias, passes, phone, status, confirmed_passes)
      VALUES (?, ?, ?, ?, ?, ?, 'pendiente', 0)
    `);
    const result = stmt.run(code, first_name.trim(), last_name.trim(), alias ? alias.trim() : null, passCount, phone ? phone.trim() : null);

    res.json({
      success: true,
      guest: {
        id: result.lastInsertRowid,
        code,
        first_name,
        last_name,
        alias,
        passes: passCount
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al registrar invitado: ' + err.message });
  }
});

// EDITAR INVITADO (Actualiza datos y recalcula pases confirmados si se reducen los asignados)
app.put('/api/guests/:id', (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, alias, passes, phone } = req.body;

  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'Nombre y apellido requeridos.' });
  }

  const passCount = parseInt(passes, 10) || 1;

  try {
    // Si ya estaba confirmado, sus pases ocupados no pueden superar el nuevo límite
    db.prepare(`
      UPDATE guests 
      SET first_name = ?, 
          last_name = ?, 
          alias = ?, 
          passes = ?, 
          phone = ?, 
          confirmed_passes = CASE 
            WHEN status = 'confirmado' AND confirmed_passes > ? THEN ? 
            ELSE confirmed_passes 
          END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(first_name.trim(), last_name.trim(), alias ? alias.trim() : null, passCount, phone ? phone.trim() : null, passCount, passCount, id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar: ' + err.message });
  }
});

// ELIMINAR INVITADO (Libera inmediatamente los pases ocupados y asignados)
app.delete('/api/guests/:id', (req, res) => {
  const { id } = req.params;
  try {
    db.prepare("DELETE FROM guests WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar: ' + err.message });
  }
});

// Consulta de la invitación por código
app.get('/api/invitation/:code', (req, res) => {
  const { code } = req.params;
  const guest = db.prepare("SELECT code, first_name, last_name, alias, passes, status, confirmed_passes FROM guests WHERE code = ?").get(code);

  if (!guest) {
    return res.status(404).json({ error: 'Invitación no encontrada' });
  }
  res.json(guest);
});

// RSVP desde la invitación
app.post('/api/invitation/:code/rsvp', (req, res) => {
  const { code } = req.params;
  const { status, attending_count, guest_phone } = req.body;

  const guest = db.prepare("SELECT * FROM guests WHERE code = ?").get(code);
  if (!guest) {
    return res.status(404).json({ error: 'Invitación no válida' });
  }

  const isAttending = status === 'si';
  const newStatus = isAttending ? 'confirmado' : 'rechazado';
  const confirmedCount = isAttending ? Math.min(parseInt(attending_count, 10) || 1, guest.passes) : 0;

  db.prepare(`
    UPDATE guests
    SET status = ?, confirmed_passes = ?, guest_phone = ?, updated_at = CURRENT_TIMESTAMP
    WHERE code = ?
  `).run(newStatus, confirmedCount, guest_phone || '', code);

  res.json({
    success: true,
    status: newStatus,
    confirmed_passes: confirmedCount
  });
});

app.listen(PORT, () => {
  console.log(`Servidor activo en http://localhost:${PORT}`);
  console.log(`Panel de Administración: http://localhost:${PORT}/admin.html`);
});