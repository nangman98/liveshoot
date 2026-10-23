import Foundation
import Network

/// 카메라(a7 IV의 FTP 전송)가 보내는 파일을 받는 최소 FTP 서버.
/// 수동(PASV·EPSV) 모드만 지원하고, 받은 파일은 folder에 평평하게 저장한다.
final class FTPServer {
    let port: UInt16
    let folder: URL
    let user: String
    let password: String
    var onFile: ((URL) -> Void)?
    var onState: ((String) -> Void)?
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "liveshoot.ftp")
    private var sessions: [ObjectIdentifier: FTPSession] = [:]

    init(port: UInt16 = 2121, folder: URL, user: String = "liveshoot", password: String = "liveshoot") {
        self.port = port
        self.folder = folder
        self.user = user
        self.password = password
    }

    func start() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        guard let p = NWEndpoint.Port(rawValue: port) else { return }
        let l = try NWListener(using: .tcp, on: p)
        l.newConnectionHandler = { [weak self] c in self?.accept(c) }
        l.stateUpdateHandler = { [weak self] s in
            switch s {
            case .ready: self?.onState?("대기 중")
            case .failed(let e): self?.onState?("오류: \(e)")
            case .cancelled: self?.onState?("꺼짐")
            default: break
            }
        }
        l.start(queue: queue)
        listener = l
    }

    func stop() {
        listener?.cancel()
        listener = nil
        queue.async {
            self.sessions.values.forEach { $0.close() }
            self.sessions.removeAll()
        }
    }

    private func accept(_ c: NWConnection) {
        let s = FTPSession(control: c, server: self, queue: queue)
        sessions[ObjectIdentifier(s)] = s
        s.onClose = { [weak self, weak s] in
            if let s { self?.sessions.removeValue(forKey: ObjectIdentifier(s)) }
        }
        s.start()
        onState?("카메라 연결됨")
    }

    fileprivate func received(_ url: URL) { onFile?(url) }
    fileprivate func check(_ u: String, _ p: String) -> Bool { u == user && p == password }
}

private final class FTPSession {
    let control: NWConnection
    unowned let server: FTPServer
    let queue: DispatchQueue
    var onClose: (() -> Void)?
    private var buffer = Data()
    private var user = ""
    private var loggedIn = false
    private var cwd = "/"
    private var pasv: NWListener?
    private var data: NWConnection?
    private var waitingForData: ((NWConnection) -> Void)?

    init(control: NWConnection, server: FTPServer, queue: DispatchQueue) {
        self.control = control
        self.server = server
        self.queue = queue
    }

    func start() {
        control.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled: self?.close()
            default: break
            }
        }
        control.start(queue: queue)
        reply("220 LiveShoot FTP ready")
        readLine()
    }

    func close() {
        pasv?.cancel()
        data?.cancel()
        control.cancel()
        onClose?()
        onClose = nil
    }

    private func reply(_ s: String) {
        control.send(content: Data((s + "\r\n").utf8), completion: .contentProcessed { _ in })
    }

    private func readLine() {
        control.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] d, _, done, err in
            guard let self else { return }
            if let d { self.buffer.append(d) }
            while let r = self.buffer.range(of: Data("\r\n".utf8)) {
                let line = String(decoding: self.buffer.subdata(in: self.buffer.startIndex..<r.lowerBound), as: UTF8.self)
                self.buffer = self.buffer.subdata(in: r.upperBound..<self.buffer.endIndex)
                self.handle(line)
            }
            if done || err != nil { self.close() } else { self.readLine() }
        }
    }

    private func handle(_ line: String) {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let cmd = parts.first?.uppercased() ?? ""
        let arg = parts.count > 1 ? parts[1] : ""
        if !loggedIn && !["USER", "PASS", "QUIT", "FEAT", "SYST", "OPTS", "AUTH"].contains(cmd) {
            reply("530 Please login")
            return
        }
        switch cmd {
        case "USER": user = arg; reply("331 Password required")
        case "PASS":
            if server.check(user, arg) { loggedIn = true; reply("230 Logged in") } else { reply("530 Login incorrect") }
        case "AUTH": reply("502 TLS not supported")
        case "SYST": reply("215 UNIX Type: L8")
        case "FEAT": reply("211-Features\r\n PASV\r\n EPSV\r\n UTF8\r\n211 End")
        case "OPTS": reply("200 OK")
        case "PWD", "XPWD": reply("257 \"\(cwd)\"")
        case "CWD", "XCWD":
            cwd = arg.hasPrefix("/") ? arg : (cwd == "/" ? "/" + arg : cwd + "/" + arg)
            reply("250 OK")
        case "CDUP": cwd = "/"; reply("250 OK")
        case "MKD", "XMKD": reply("257 \"\(arg)\" created")
        case "TYPE", "MODE", "STRU", "NOOP": reply("200 OK")
        case "ALLO": reply("202 OK")
        case "SIZE", "MDTM": reply("550 Not found")
        case "DELE", "RMD", "RNTO": reply("250 OK")
        case "RNFR": reply("350 OK")
        case "PASV": openPassive(extended: false)
        case "EPSV": openPassive(extended: true)
        case "PORT", "EPRT": reply("502 Use passive mode")
        case "LIST", "NLST", "MLSD": list()
        case "STOR", "APPE": store(arg)
        case "QUIT":
            reply("221 Bye")
            queue.asyncAfter(deadline: .now() + 0.2) { self.close() }
        default: reply("502 Not implemented")
        }
    }

    private func openPassive(extended: Bool) {
        pasv?.cancel()
        data?.cancel()
        data = nil
        guard let l = try? NWListener(using: .tcp, on: .any) else { reply("425 Cannot open data port"); return }
        l.newConnectionHandler = { [weak self, weak l] c in
            guard let self else { return }
            c.start(queue: self.queue)
            if let w = self.waitingForData { self.waitingForData = nil; w(c) } else { self.data = c }
            l?.cancel()   // PASV 한 번에 연결 하나
        }
        l.stateUpdateHandler = { [weak self, weak l] st in
            guard let self, case .ready = st, let port = l?.port?.rawValue else { return }
            if extended {
                self.reply("229 Entering Extended Passive Mode (|||\(port)|)")
            } else {
                let ip = self.localIPv4() ?? "127.0.0.1"
                self.reply("227 Entering Passive Mode (\(ip.replacingOccurrences(of: ".", with: ",")),\(port >> 8),\(port & 255))")
            }
        }
        l.start(queue: queue)
        pasv = l
    }

    /// 카메라가 접속해 온 이쪽 주소 (PASV 응답에 넣는다)
    private func localIPv4() -> String? {
        guard case let .hostPort(host, _)? = control.currentPath?.localEndpoint else { return nil }
        var s = "\(host)"
        if let i = s.firstIndex(of: "%") { s = String(s[..<i]) }
        if s.hasPrefix("::ffff:") { s = String(s.dropFirst(7)) }
        return s.split(separator: ".").count == 4 ? s : nil
    }

    private func withData(_ f: @escaping (NWConnection) -> Void) {
        if let c = data { data = nil; f(c) } else { waitingForData = f }
    }

    private func list() {
        reply("150 Listing")
        withData { c in
            c.send(content: Data(), contentContext: .defaultMessage, isComplete: true, completion: .contentProcessed { _ in
                c.cancel()
                self.reply("226 Done")
            })
        }
    }

    private func store(_ name: String) {
        let base = (name as NSString).lastPathComponent
        guard !base.isEmpty else { reply("501 No file name"); return }
        reply("150 Ok to send data")
        withData { c in
            let tmp = self.server.folder.appendingPathComponent("." + base + ".part")
            FileManager.default.createFile(atPath: tmp.path, contents: nil)
            guard let h = try? FileHandle(forWritingTo: tmp) else {
                self.reply("451 Cannot write")
                c.cancel()
                return
            }
            self.receiveFile(c, h, tmp, base)
        }
    }

    private func receiveFile(_ c: NWConnection, _ h: FileHandle, _ tmp: URL, _ name: String) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] d, _, done, err in
            guard let self else { return }
            if let d, !d.isEmpty { h.write(d) }
            if err != nil {
                try? h.close()
                c.cancel()
                try? FileManager.default.removeItem(at: tmp)
                self.reply("426 Transfer aborted")
            } else if done {
                try? h.close()
                c.cancel()
                let dst = uniqueURL(self.server.folder, name)
                try? FileManager.default.moveItem(at: tmp, to: dst)
                self.reply("226 Transfer complete")
                self.server.received(dst)
            } else {
                self.receiveFile(c, h, tmp, name)
            }
        }
    }
}

/// 같은 이름이 있으면 name_1.jpg, name_2.jpg …
func uniqueURL(_ folder: URL, _ name: String) -> URL {
    var url = folder.appendingPathComponent(name)
    let stem = (name as NSString).deletingPathExtension, ext = (name as NSString).pathExtension
    var i = 1
    while FileManager.default.fileExists(atPath: url.path) {
        url = folder.appendingPathComponent("\(stem)_\(i).\(ext)")
        i += 1
    }
    return url
}
