# Ferbos PCB EOL Web Tester

Static website untuk testing PCB lewat Web Serial API.

## Cara Run

Jalankan dari root repo:

```bash
python3 -m http.server 8080
```

Lalu buka:

```text
http://localhost:8080/ferbos-pcb-testing/
```

Gunakan Chrome atau Edge desktop karena Web Serial API perlu browser yang
mendukung `navigator.serial` dan halaman harus dibuka dari `localhost` atau
HTTPS.

## Struktur

- `index.html`: layout utama.
- `styles.css`: semua styling UI.
- `js/main.js`: wiring UI, flow command, dan routing event.
- `js/core/serialClient.js`: Web Serial connect/read/write JSON line.
- `js/core/testRegistry.js`: daftar test point dan kriteria pass.
- `js/core/state.js`: state kecil untuk status test dan log.
- `js/components/render.js`: render test list, detail, form, dan timeline.

Untuk menambah test mode baru, tambahkan item baru di `js/core/testRegistry.js`.
