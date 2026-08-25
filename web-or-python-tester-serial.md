# Web/Python Tester Serial Contract

Dokumen ini menjelaskan cara aplikasi tester berkomunikasi dengan firmware
`ferbos_pcb_testing_eol_main` lewat serial. Aplikasi tester bisa berupa website
dengan Web Serial API atau script Python dengan `pyserial`. Keduanya punya peran
yang sama: menjadi host aktif yang mengatur urutan test, mengirim command ke S3,
membaca response, membaca event asynchronous, lalu menampilkan hasil ke operator.

Firmware S3 bersifat pasif. Firmware tidak menjalankan seluruh urutan test
sendiri. Firmware hanya:

- menerima satu command JSON per baris dari host,
- menjalankan test yang diminta,
- mengirim satu response JSON untuk request tersebut,
- mengirim event JSON tambahan saat status hardware berubah.

## Ringkasan Test

Bagian yang dites:

- S3 firmware alive: memastikan firmware main sudah ter-flash dan serial host
  hidup.
- S3 info: membaca chip/free heap untuk identitas awal.
- C6 firmware alive dan UART S3-C6: S3 mengirim payload ke C6, C6 membalas
  payload yang sama plus metadata `processed_by`.
- Ethernet DM9051: S3 start Ethernet, menunggu kabel, memberi event link up,
  IP, link down, lalu bisa distop.
- WiFi STA: host mengirim SSID/password, S3 connect WiFi, lalu memberi event IP.
  Sebelum WiFi dimulai, firmware akan stop Ethernet jika Ethernet masih running.
- BLE: host meminta BLE start/echo/stop. Saat `CONFIG_BT_ENABLED` masih off,
  firmware membalas status disabled secara eksplisit.
- RS485 connector: S3 mengirim payload raw ke RS485 dan menunggu data balasan.
  Ini test konektor dan arah TX/RX/DE, bukan validasi register Modbus penuh.

Test Zigbee network pairing/device belum masuk fase ini. Yang dites untuk C6 saat
ini adalah flash/alive dan komunikasi UART S3-C6.

## Transport Serial

Gunakan USB serial / UART console S3.

Parameter default:

- Baudrate: `115200`
- Data bits: `8`
- Parity: none
- Stop bits: `1`
- Flow control: none
- Encoding: UTF-8 / ASCII JSON
- Framing: newline-delimited JSON (`\n`)

Setiap request wajib dikirim sebagai satu baris JSON dan diakhiri newline:

```text
{"id":"1","cmd":"ping"}\n
```

Host wajib membaca stream serial terus-menerus karena firmware bisa mengirim
event tanpa menunggu command baru, misalnya saat kabel Ethernet dicabut.

## Tipe Pesan dari Firmware

Firmware mengirim tiga tipe pesan utama.

Boot message:

```json
{"type":"boot","target":"s3-main","app":"ferbos_pcb_testing_eol_main","ready":true}
```

Response untuk command host:

```json
{"type":"response","id":"1","cmd":"ping","ok":true,"detail":"s3 firmware alive","ts_ms":1234}
```

Event asynchronous:

```json
{"type":"event","test":"ethernet","state":"got_ip","detail":"ip=192.168.1.20 gw=192.168.1.1","ts_ms":5678}
```

Field umum:

- `type`: `boot`, `response`, atau `event`.
- `id`: id request dari host. Hanya ada pada response.
- `cmd`: command yang sedang dijawab. Hanya ada pada response.
- `ok`: hasil command. `true` berarti command diterima dan proses awal sukses.
- `detail`: string ringkas untuk UI/log operator.
- `test`: nama test yang menghasilkan event.
- `state`: state event.
- `ts_ms`: uptime firmware dalam millisecond.

## Aturan Host Tester

Host website/Python sebaiknya punya dua loop:

- Writer: mengirim command berdasarkan tombol/operator/flow otomatis.
- Reader: selalu membaca serial line, parse JSON, lalu routing berdasarkan
  `type`.

Cara mapping response:

- Saat host mengirim command, buat `id` unik, misalnya counter string `"1"`.
- Simpan request pending berdasarkan `id`.
- Saat menerima `type:"response"`, cocokkan ke pending request dengan `id`.
- Saat menerima `type:"event"`, jangan cari `id`; tampilkan ke panel event test
  yang sesuai.

Timeout host:

- Command cepat seperti `ping`, `info`, `eth_start`, `eth_stop`, `wifi_stop`,
  `ble_start`, `ble_stop`: timeout host 1-3 detik cukup.
- `c6_ping`: timeout host sebaiknya sedikit lebih besar dari `timeout_ms` yang
  dikirim ke firmware.
- `wifi_connect`: response awal hanya berarti proses connect dimulai. Status
  berhasil WiFi harus menunggu event `test:"wifi", state:"got_ip"`.
- `eth_start`: response awal hanya berarti Ethernet start. Status berhasil link
  dan IP harus menunggu event `ethernet/link_up` dan `ethernet/got_ip`.
- `rs485_exchange`: timeout host harus lebih besar dari `timeout_ms` di payload.

## Urutan Test yang Disarankan

1. Buka serial ke S3.
2. Tunggu boot message `ready:true`.
3. Kirim `ping`.
4. Kirim `info`.
5. Kirim `c6_ping` untuk memastikan C6 sudah ter-flash dan UART S3-C6 dua arah.
6. Kirim `eth_start`.
7. Tampilkan instruksi operator untuk colok kabel Ethernet.
8. Tunggu event `ethernet/link_up`.
9. Tunggu event `ethernet/got_ip`.
10. Tampilkan instruksi operator untuk cabut kabel Ethernet.
11. Tunggu event `ethernet/link_down`.
12. Kirim `eth_stop`.
13. Kirim `wifi_connect` dengan SSID/password.
14. Tunggu event `wifi/got_ip`.
15. Kirim `wifi_stop` jika test WiFi selesai.
16. Kirim `ble_start`.
17. Kalau response `ok:false` dengan `disabled_by_sdkconfig`, tandai BLE belum
    bisa dites sampai config BT diaktifkan.
18. Kirim `rs485_exchange` saat jig/adapter RS485 sudah siap membalas.

## Command: `ping`

Fungsi:

Memastikan firmware S3 sudah hidup, serial RX/TX host jalan, dan parser command
berfungsi.

Request:

```json
{"id":"1","cmd":"ping"}
```

Response berhasil:

```json
{"type":"response","id":"1","cmd":"ping","ok":true,"detail":"s3 firmware alive","ts_ms":100}
```

Kriteria lulus:

- Ada response dengan `type:"response"`.
- `id` sama dengan request.
- `cmd` sama dengan `ping`.
- `ok` bernilai `true`.

## Command: `info`

Fungsi:

Membaca identitas runtime dasar S3, terutama untuk ditampilkan di UI/log.

Request:

```json
{"id":"2","cmd":"info"}
```

Response berhasil:

```json
{"type":"response","id":"2","cmd":"info","ok":true,"detail":"chip_model=9 cores=2 free_heap=245000","ts_ms":200}
```

Kriteria lulus:

- `ok:true`.
- `detail` berisi `chip_model`, `cores`, dan `free_heap`.

## Command: `c6_ping`

Fungsi:

Memastikan firmware C6 sudah ter-flash, UART S3-C6 tersambung, C6 bisa menerima
payload, memproses command, dan mengirim payload balik ke S3.

Request dari host ke S3:

```json
{"id":"3","cmd":"c6_ping","payload":"hello-c6","timeout_ms":1000}
```

Payload internal dari S3 ke C6:

```json
{"cmd":"probe_echo","id":"3","payload":"hello-c6","from":"s3"}
```

Response internal dari C6 ke S3:

```json
{"ok":true,"id":"3","cmd":"probe_echo","echo":"hello-c6","processed":true,"processed_by":"c6-zigbee","free_heap":123456}
```

Event yang bisa muncul dari S3:

```json
{"type":"event","test":"c6","state":"tx","detail":"hello-c6","ts_ms":300}
{"type":"event","test":"c6","state":"rx_ok","detail":"c6 echo ok processed_by=c6-zigbee","ts_ms":330}
```

Response berhasil ke host:

```json
{"type":"response","id":"3","cmd":"c6_ping","ok":true,"detail":"c6 echo ok processed_by=c6-zigbee","ts_ms":331}
```

Response gagal timeout:

```json
{"type":"event","test":"c6","state":"timeout","detail":"c6 timeout waiting response","ts_ms":1300}
{"type":"response","id":"3","cmd":"c6_ping","ok":false,"detail":"c6 timeout waiting response","ts_ms":1301}
```

Kriteria lulus:

- Response akhir `ok:true`.
- Ada metadata `processed_by=c6-zigbee` di `detail`.
- Payload yang dikirim host sama dengan `echo` yang divalidasi S3.

## Command: `eth_start`

Fungsi:

Menyalakan Ethernet DM9051 dan membuat firmware menunggu operator mencolok kabel.

Request:

```json
{"id":"4","cmd":"eth_start"}
```

Response berhasil:

```json
{"type":"response","id":"4","cmd":"eth_start","ok":true,"detail":"ethernet waiting link","ts_ms":400}
```

Event saat driver mulai:

```json
{"type":"event","test":"ethernet","state":"waiting_link","detail":"ethernet started, waiting user plug cable","ts_ms":410}
```

Event saat kabel/link up:

```json
{"type":"event","test":"ethernet","state":"link_up","detail":"link up mac=02:00:00:00:00:01","ts_ms":2500}
```

Event saat mendapat IP:

```json
{"type":"event","test":"ethernet","state":"got_ip","detail":"ip=192.168.1.20 gw=192.168.1.1","ts_ms":3500}
```

Event saat kabel dicabut:

```json
{"type":"event","test":"ethernet","state":"link_down","detail":"cable unplugged or link lost","ts_ms":8000}
```

Kriteria lulus:

- `eth_start` response `ok:true`.
- Setelah operator colok kabel, muncul `ethernet/link_up`.
- Setelah DHCP berhasil, muncul `ethernet/got_ip`.
- Saat kabel dicabut, muncul `ethernet/link_down`.

## Command: `eth_stop`

Fungsi:

Mematikan Ethernet sebelum test WiFi atau sebelum pindah test lain.

Request:

```json
{"id":"5","cmd":"eth_stop"}
```

Response berhasil:

```json
{"type":"response","id":"5","cmd":"eth_stop","ok":true,"detail":"ethernet stopped","ts_ms":9000}
```

Event:

```json
{"type":"event","test":"ethernet","state":"stopped","detail":"ethernet stopped","ts_ms":9001}
```

Kriteria lulus:

- Response `ok:true`.
- UI boleh lanjut ke WiFi test setelah menerima response ini.

## Command: `wifi_connect`

Fungsi:

Menghubungkan S3 ke WiFi menggunakan SSID/password dari host. Firmware akan
mematikan Ethernet dulu jika Ethernet masih running.

Request:

```json
{"id":"6","cmd":"wifi_connect","ssid":"FactoryAP","password":"secret"}
```

Event jika Ethernet masih running:

```json
{"type":"event","test":"ethernet","state":"stopped_for_wifi","detail":"ethernet stopped before wifi test","ts_ms":10000}
```

Response berhasil memulai connect:

```json
{"type":"response","id":"6","cmd":"wifi_connect","ok":true,"detail":"wifi connecting, wait got_ip event","ts_ms":10020}
```

Event saat WiFi mulai connect:

```json
{"type":"event","test":"wifi","state":"connecting","detail":"wifi station started","ts_ms":10030}
```

Event saat WiFi mendapat IP:

```json
{"type":"event","test":"wifi","state":"got_ip","detail":"ip=192.168.1.21 gw=192.168.1.1","ts_ms":13000}
```

Event jika disconnect:

```json
{"type":"event","test":"wifi","state":"disconnected","detail":"disconnected reason=201","ts_ms":15000}
```

Kriteria lulus:

- Response command `ok:true`.
- Event akhir yang ditunggu adalah `wifi/got_ip`.
- Jika hanya response `ok:true` tapi tidak ada `wifi/got_ip`, test belum lulus.

## Command: `wifi_stop`

Fungsi:

Mematikan WiFi setelah test selesai.

Request:

```json
{"id":"7","cmd":"wifi_stop"}
```

Response berhasil:

```json
{"type":"response","id":"7","cmd":"wifi_stop","ok":true,"detail":"wifi stopped","ts_ms":16000}
```

Event:

```json
{"type":"event","test":"wifi","state":"stopped","detail":"wifi stopped","ts_ms":16001}
```

Kriteria lulus:

- Response `ok:true`.

## Command: `ble_start`

Fungsi:

Meminta firmware membuka BLE untuk test payload dari web BLE. Pada implementasi
saat ini, command ini juga dipakai untuk memberi tahu host jika build config
belum mengaktifkan Bluetooth.

Request:

```json
{"id":"8","cmd":"ble_start"}
```

Response jika Bluetooth belum aktif di `sdkconfig`:

```json
{"type":"event","test":"ble","state":"disabled","detail":"disabled_by_sdkconfig: CONFIG_BT_ENABLED is off","ts_ms":17000}
{"type":"response","id":"8","cmd":"ble_start","ok":false,"detail":"disabled_by_sdkconfig: CONFIG_BT_ENABLED is off","ts_ms":17001}
```

Response berhasil jika build config sudah mendukung BLE:

```json
{"type":"event","test":"ble","state":"started","detail":"ble enabled placeholder service started","ts_ms":17000}
{"type":"response","id":"8","cmd":"ble_start","ok":true,"detail":"ble enabled placeholder service started","ts_ms":17001}
```

Kriteria lulus fase sekarang:

- Jika `CONFIG_BT_ENABLED` masih off, host harus menampilkan bahwa BLE belum bisa
  dites karena konfigurasi firmware, bukan hardware fail.
- Setelah BLE benar-benar diimplementasikan dan config aktif, lulus jika
  `ble_start` response `ok:true` dan web bisa connect.

## Command: `ble_echo`

Fungsi:

Mewakili test payload BLE echo. Untuk firmware sekarang, ini command serial host
yang memanggil service BLE echo. Setelah BLE GATT aktif nanti, payload yang
datang dari BLE harus menghasilkan metadata proses yang sama.

Request:

```json
{"id":"9","cmd":"ble_echo","payload":"hello-ble"}
```

Response jika BLE belum running:

```json
{"type":"event","test":"ble","state":"echo","detail":"ble echo processed payload=hello-ble","ts_ms":18000}
{"type":"response","id":"9","cmd":"ble_echo","ok":false,"detail":"ble echo processed payload=hello-ble","ts_ms":18001}
```

Response jika BLE running:

```json
{"type":"event","test":"ble","state":"echo","detail":"ble echo processed payload=hello-ble","ts_ms":18000}
{"type":"response","id":"9","cmd":"ble_echo","ok":true,"detail":"ble echo processed payload=hello-ble","ts_ms":18001}
```

Kriteria lulus:

- Untuk test BLE penuh, `ble_start` harus `ok:true`.
- `ble_echo` harus `ok:true`.
- `detail` harus membawa payload yang dikirim.

## Command: `ble_stop`

Fungsi:

Menghentikan mode BLE test.

Request:

```json
{"id":"10","cmd":"ble_stop"}
```

Response berhasil:

```json
{"type":"event","test":"ble","state":"stopped","detail":"ble stopped","ts_ms":19000}
{"type":"response","id":"10","cmd":"ble_stop","ok":true,"detail":"ble stopped","ts_ms":19001}
```

Kriteria lulus:

- Response `ok:true`.

## Command: `rs485_exchange`

Fungsi:

Test konektor RS485. Firmware S3 akan:

1. Set DE/RE ke transmit.
2. Kirim payload plus newline ke UART RS485.
3. Set DE/RE kembali ke receive.
4. Menunggu satu line balasan.
5. Melaporkan data yang diterima.

Request:

```json
{"id":"11","cmd":"rs485_exchange","payload":"EOL_RS485_PING","timeout_ms":1000}
```

Response berhasil:

```json
{"type":"event","test":"rs485","state":"rx","detail":"tx=EOL_RS485_PING rx=EOL_RS485_PONG","ts_ms":20000}
{"type":"response","id":"11","cmd":"rs485_exchange","ok":true,"detail":"tx=EOL_RS485_PING rx=EOL_RS485_PONG","ts_ms":20001}
```

Response timeout/gagal:

```json
{"type":"event","test":"rs485","state":"error","detail":"tx=EOL_RS485_PING err=ESP_ERR_TIMEOUT","ts_ms":21000}
{"type":"response","id":"11","cmd":"rs485_exchange","ok":false,"detail":"tx=EOL_RS485_PING err=ESP_ERR_TIMEOUT","ts_ms":21001}
```

Kriteria lulus:

- Ada response `ok:true`.
- `detail` berisi `tx=<payload>` dan `rx=<payload-balasan>`.
- Balasan RS485 harus berasal dari jig/alat lawan. Jika tidak ada alat lawan,
  timeout bukan bukti firmware rusak; itu hanya berarti tidak ada balasan masuk.

## Command: `help`

Fungsi:

Membaca daftar command yang tersedia dari firmware.

Request:

```json
{"id":"12","cmd":"help"}
```

Response:

```json
{"type":"response","cmd":"help","ok":true,"commands":["ping","info","c6_ping","eth_start","eth_stop","wifi_connect","wifi_stop","ble_start","ble_stop","ble_echo","rs485_exchange"]}
```

Catatan:

Response `help` saat ini tidak membawa `id`. Host jangan memakai `help` sebagai
bagian wajib flow produksi sampai field `id` ditambahkan, atau perlakukan
response `cmd:"help"` sebagai special-case.

## Error Umum

Invalid JSON:

Request salah:

```text
hello
```

Response:

```json
{"type":"response","id":"","cmd":"parse","ok":false,"detail":"invalid json line","ts_ms":1}
```

Unknown command:

Request:

```json
{"id":"99","cmd":"not_exist"}
```

Response:

```json
{"type":"response","id":"99","cmd":"not_exist","ok":false,"detail":"unknown cmd: not_exist","ts_ms":1}
```

## Contoh Flow Website

Website tester minimal perlu:

- Tombol connect serial.
- Dropdown serial baudrate default `115200`.
- Panel log raw JSON line.
- Panel status per test: S3, C6, Ethernet, WiFi, BLE, RS485.
- Form WiFi SSID/password.
- Tombol per test atau tombol run-all.

Web Serial pseudo-flow:

```js
const port = await navigator.serial.requestPort();
await port.open({ baudRate: 115200 });

const writer = port.writable.getWriter();
const encoder = new TextEncoder();

async function sendJson(obj) {
  await writer.write(encoder.encode(JSON.stringify(obj) + "\n"));
}

await sendJson({ id: "1", cmd: "ping" });
```

Reader website harus mem-buffer sampai newline, lalu `JSON.parse(line)`.

## Contoh Flow Python

Python tester minimal perlu:

- Buka serial dengan `pyserial`.
- Thread/loop reader yang selalu membaca line.
- Function `send(cmd)` yang memberi `id` otomatis.
- Pending map berdasarkan `id`.
- Event handler untuk `type:"event"`.

Contoh sederhana:

```python
import json
import serial
import time

ser = serial.Serial("/dev/ttyUSB0", 115200, timeout=0.1)
counter = 0

def send(cmd, **kwargs):
    global counter
    counter += 1
    payload = {"id": str(counter), "cmd": cmd, **kwargs}
    ser.write((json.dumps(payload) + "\n").encode())
    return payload["id"]

def read_line():
    raw = ser.readline()
    if not raw:
        return None
    return json.loads(raw.decode(errors="replace"))

send("ping")
deadline = time.time() + 3
while time.time() < deadline:
    msg = read_line()
    if not msg:
        continue
    print(msg)
```

## Rekomendasi UI Status

S3:

- Pending: serial belum connect.
- Pass: `ping` response `ok:true`.
- Fail: timeout atau invalid JSON.

C6:

- Pending: belum `c6_ping`.
- Pass: `c6_ping` response `ok:true`.
- Fail: `timeout`, `rx_fail`, atau response `ok:false`.

Ethernet:

- Waiting user: event `ethernet/waiting_link`.
- Link pass: event `ethernet/link_up`.
- IP pass: event `ethernet/got_ip`.
- Unplug detected: event `ethernet/link_down`.

WiFi:

- Connecting: response `wifi_connect ok:true` atau event `wifi/connecting`.
- Pass: event `wifi/got_ip`.
- Fail: event `wifi/disconnected` tanpa `got_ip` sampai timeout host.

BLE:

- Blocked by config: response `ok:false` dengan `disabled_by_sdkconfig`.
- Pass fase penuh nanti: `ble_start ok:true`, web BLE connected, payload echo
  sukses.

RS485:

- Pass: `rs485_exchange ok:true`.
- Fail: `ESP_ERR_TIMEOUT` atau response `ok:false`.

## Checklist Implementasi Host

- Selalu kirim newline setelah JSON.
- Jangan kirim command berikutnya yang tergantung test sebelumnya sebelum
  menerima response/event yang dibutuhkan.
- Bedakan response dan event.
- Jangan menganggap `wifi_connect ok:true` berarti WiFi sudah punya IP.
- Jangan menganggap `eth_start ok:true` berarti kabel sudah link up.
- Tampilkan `detail` mentah ke operator; string ini sengaja dibuat mudah dibaca.
- Simpan raw log per unit PCB agar failure bisa ditelusuri ulang.
