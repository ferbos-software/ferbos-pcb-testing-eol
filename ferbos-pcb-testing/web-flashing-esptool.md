# Panduan Implementasi Web Flashing (esptool-js)

Dokumen ini menjabarkan cara untuk menambahkan fitur *Web Flashing* langsung dari UI Website `ferbos-pcb-testing` ke alat uji (ESP32-S3), sehingga operator bisa mengklik tombol "Flash" dan alat uji akan terprogram otomatis sebelum tahap tes dimulai.

## 1. Referensi Alamat (Address) Firmware untuk ESP32-S3
Jika Anda menggunakan command CLI `esptool.py` atau `idf.py flash`, alat ini mem-*flash* 3 file utama ke memori dengan alamat (offset hex) berikut:

Berdasarkan konfigurasi ESP32-S3 dari proyek `ferbos_pcb_testing_eol_main`, susunan memori (*flash args*) adalah sebagai berikut:
- **`0x0`** : `bootloader.bin` (Bootloader ESP32-S3 dimulai di `0x0`, berbeda dengan ESP32 klasik di `0x1000`)
- **`0x8000`** : `partition-table.bin` (Tabel partisi default)
- **`0x10000`** : `ferbos-pcb-testing-eol-main.bin` (Aplikasi Firmware utama)

**Command CLI asli (referensi):**
```bash
esptool.py -p /dev/ttyUSB0 -b 460800 --before default_reset --after hard_reset --chip esp32s3 write_flash --flash_mode dio --flash_freq 80m --flash_size 2MB 0x0 bootloader.bin 0x8000 partition-table.bin 0x10000 firmware.bin
```

## 2. Cara Kerja esptool-js di Web

Pustaka [esptool-js](https://github.com/espressif/esptool-js) menggunakan Web Serial API (sama seperti yang Anda gunakan untuk tester).
Untuk menggabungkannya ke aplikasi saat ini:
1. File `.bin` (bootloader, partition, dan firmware) di-host (disimpan) di dalam folder public/static website agar bisa diakses lewat `fetch()`.
2. Anda menutup (*disconnect*) koneksi serial tester biasa jika sedang terbuka.
3. Memberikan *port* serial tersebut ke `esptool-js` untuk melakukan proses *flashing*.
4. Setelah selesai, buka kembali port serial tersebut untuk masuk ke *mode test*.

## 3. Langkah Implementasi (Langkah demi Langkah)

### Langkah 1: Memuat Script esptool-js
Anda bisa memuat *bundle* dari CDN atau menyimpannya secara lokal di web Anda. Tambahkan ini di `index.html`:
```html
<script src="https://unpkg.com/esp-web-flasher@latest/dist/index.js"></script>
```
*(Catatan: Anda juga bisa menggunakan paket npm `esptool-js`)*.

### Langkah 2: Buat Tombol Flash di UI
Di `index.html` pada bagian koneksi, tambahkan tombol Flash:
```html
<button id="flashButton" class="btn btn-warning" type="button">Flash Firmware</button>
<div id="flashProgress" style="display: none;">
  <span>Flashing: <span id="flashPercentage">0%</span></span>
</div>
```

### Langkah 3: Taruh File `.bin` Anda di Folder Web
Buat folder `firmware/` di dalam direktori website dan salin hasil build ESP-IDF ke sana:
- `/firmware/bootloader.bin`
- `/firmware/partition-table.bin`
- `/firmware/ferbos-pcb-testing-eol-main.bin`

### Langkah 4: Logika Flashing (JavaScript)
Di file JavaScript (misalnya di `main.js`), Anda dapat membuat fungsi async untuk meng-*handle* proses flashing:

```javascript
import { ESPLoader, Transport } from "esptool-js";

async function flashFirmware(port) {
  try {
    // 1. Ambil file .bin menggunakan Fetch API
    const [bootloaderUrl, partitionUrl, appUrl] = await Promise.all([
      fetch('./firmware/bootloader.bin').then(r => r.arrayBuffer()),
      fetch('./firmware/partition-table.bin').then(r => r.arrayBuffer()),
      fetch('./firmware/ferbos-pcb-testing-eol-main.bin').then(r => r.arrayBuffer())
    ]);

    // 2. Siapkan konfigurasi file yang akan di flash
    const fileArray = [
      { data: new Uint8Array(bootloaderUrl), address: 0x0 },
      { data: new Uint8Array(partitionUrl), address: 0x8000 },
      { data: new Uint8Array(appUrl), address: 0x10000 }
    ];

    // 3. Konfigurasi Transport Serial untuk esptool
    const transport = new Transport(port);
    const flashOptions = {
      transport: transport,
      baudrate: 460800, // Kecepatan aman untuk flash
      terminal: {
        clean: () => {}, // fungsi untuk membersihkan terminal UI (jika ada)
        writeLine: (data) => console.log(data) // tampilkan log esptool
      }
    };

    // 4. Inisiasi ESPLoader dan hubungkan ke chip (ROM)
    const loader = new ESPLoader(flashOptions);
    await loader.main(); 

    // 5. Tulis (Flash) File
    await loader.write_flash(
      fileArray,
      'keep', // flash_size: biarkan apa adanya (keep)
      'dio',  // flash_mode
      '80m',  // flash_freq
      undefined,
      undefined,
      (fileIndex, written, total) => {
        // Callback untuk progress bar
        const percentage = Math.round((written / total) * 100);
        document.getElementById('flashPercentage').innerText = `${percentage}% (File ${fileIndex + 1}/3)`;
      }
    );

    console.log("Flashing selesai!");
    
    // 6. Reset (Hard Reset) chip agar booting ke aplikasi
    await loader.hard_reset();
    
    // Matikan transport esptool agar port bisa digunakan kembali oleh tester
    await transport.disconnect();

  } catch (err) {
    console.error("Error saat flashing:", err);
  }
}
```

### Langkah 5: Hubungkan ke Tombol UI
Saat tombol ditekan, pastikan Anda sedang **tidak** menggunakan port tersebut untuk *tester*:

```javascript
document.getElementById("flashButton").addEventListener("click", async () => {
  // Jika tester sedang konek, diskonek dulu agar port serial-nya bebas
  if (serial.isConnected) {
    await serial.disconnect();
  }

  try {
    // Minta user pilih port (jika belum punya object port dari tester)
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 }); // Buka port sementara untuk dilempar ke esptool
    
    document.getElementById("flashProgress").style.display = "block";
    
    await flashFirmware(port);
    
    alert("Flash sukses! Silakan klik 'Connect Serial' untuk memulai testing.");
  } catch (error) {
    alert("Gagal Flash: " + error.message);
  } finally {
    document.getElementById("flashProgress").style.display = "none";
  }
});
```

## Tips Penting:
1. **Beda Mode:** `esptool-js` berbicara dengan *Boot ROM* dari ESP32 (mode download), sedangkan *Tester* berbicara dengan *Firmware Aplikasi*. `esptool-js` akan mengirim sinyal DTR/RTS otomatis untuk me-*reset* ESP32 ke *mode download*.
2. **Berbagi Port:** Jangan menggunakan objek Web Serial `port` secara bersamaan untuk `esptool` dan aplikasi *tester* Anda. Selalu *disconnect* tester sebelum *flash*, dan biarkan *esptool* me-reset lalu *disconnect* setelah *flash* beres.
3. **CORS:** Jika file bin di-*host* di tempat lain (contoh AWS S3), pastikan aturan CORS mengizinkan web tester Anda mengambil data. Namun jika disimpan di dalam folder yang sama dengan website, ini tidak jadi masalah.

