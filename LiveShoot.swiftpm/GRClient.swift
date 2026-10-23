import Foundation
import Network

/// 리코 GR III의 Wi-Fi(카메라가 공유기, 192.168.0.1)에서 새 JPG를 2초마다 확인해 받는다.
/// 리코가 공개한 API가 아니라 GRsync 등이 쓰는 방식: GET /v1/photos → {"dirs":[{"name","files"}]}
final class GRClient {
    let host: String
    let port: UInt16
    let folder: URL
    var onFile: ((URL) -> Void)?
    var onState: ((String) -> Void)?
    private var known: Set<String>?
    private var timer: DispatchSourceTimer?
    private var busy = false
    private let queue = DispatchQueue(label: "liveshoot.gr")

    init(host: String = "192.168.0.1", port: UInt16 = 80, folder: URL) {
        self.host = host
        self.port = port
        self.folder = folder
    }

    /// includeExisting: 카메라에 이미 있던 사진도 받을지 (기본은 시작 뒤 찍은 것만)
    func start(includeExisting: Bool = false, interval: Double = 2) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        known = includeExisting ? [] : nil
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: interval)
        t.setEventHandler { [weak self] in self?.poll() }
        t.resume()
        timer = t
    }

    func stop() {
        timer?.cancel()
        timer = nil
        onState?("꺼짐")
    }

    private func poll() {
        guard !busy else { return }
        busy = true
        httpGet(host: host, port: port, path: "/v1/photos", queue: queue) { [weak self] body in
            guard let self else { return }
            guard let body,
                  let j = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
                  let dirs = j["dirs"] as? [[String: Any]] else {
                self.onState?("카메라를 찾는 중 (GR Wi-Fi에 접속했는지 확인)")
                self.busy = false
                return
            }
            var all: [String] = []
            for d in dirs {
                guard let name = d["name"] as? String, let files = d["files"] as? [String] else { continue }
                all += files.filter { $0.lowercased().hasSuffix(".jpg") }.map { "\(name)/\($0)" }
            }
            if self.known == nil {   // 처음 본 목록은 "이미 있던 사진"
                self.known = Set(all)
                self.onState?("연결됨, 새 사진 대기 중")
                self.busy = false
                return
            }
            let new = all.filter { !self.known!.contains($0) }
            self.download(new[...])
        }
    }

    private func download(_ rest: ArraySlice<String>) {
        guard let p = rest.first else { busy = false; return }
        onState?("받는 중 \(p)")
        httpGet(host: host, port: port, path: "/v1/photos/" + p, queue: queue, timeout: 60) { [weak self] body in
            guard let self else { return }
            if let body, !body.isEmpty {
                let dst = uniqueURL(self.folder, (p as NSString).lastPathComponent)
                if (try? body.write(to: dst)) != nil {
                    self.known!.insert(p)
                    self.onFile?(dst)
                }
            }
            self.onState?("연결됨, 새 사진 대기 중")
            self.download(rest.dropFirst())
        }
    }
}

/// HTTP/1.0 GET. URLSession 대신 직접 TCP로 보내 http:// 주소 제한(ATS)을 피한다. 실패하면 nil.
func httpGet(host: String, port: UInt16, path: String, queue: DispatchQueue, timeout: Double = 5,
             done: @escaping (Data?) -> Void) {
    guard let p = NWEndpoint.Port(rawValue: port) else { done(nil); return }
    let c = NWConnection(host: NWEndpoint.Host(host), port: p, using: .tcp)
    var buf = Data()
    var finished = false
    func finish(_ d: Data?) {
        guard !finished else { return }
        finished = true
        c.cancel()
        done(d)
    }
    func receive() {
        c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { d, _, end, err in
            if let d { buf.append(d) }
            if end || err != nil {
                guard let r = buf.range(of: Data("\r\n\r\n".utf8)) else { finish(nil); return }
                let head = String(decoding: buf.subdata(in: buf.startIndex..<r.lowerBound), as: UTF8.self)
                guard head.hasPrefix("HTTP/1.") && head.split(separator: " ").dropFirst().first == "200" else { finish(nil); return }
                finish(buf.subdata(in: r.upperBound..<buf.endIndex))
            } else {
                receive()
            }
        }
    }
    c.stateUpdateHandler = { st in
        switch st {
        case .ready:
            let req = "GET \(path) HTTP/1.0\r\nHost: \(host)\r\nConnection: close\r\n\r\n"
            c.send(content: Data(req.utf8), completion: .contentProcessed { _ in receive() })
        case .failed, .waiting:
            finish(nil)
        default: break
        }
    }
    c.start(queue: queue)
    queue.asyncAfter(deadline: .now() + timeout) { finish(nil) }
}

/// iPad의 Wi-Fi 주소 (카메라 FTP 설정에 넣을 값)
func wifiIPv4() -> String? {
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
    defer { freeifaddrs(ifaddr) }
    var found: String?
    for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
        let a = p.pointee
        guard let sa = a.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
        let name = String(cString: a.ifa_name)
        guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
            let s = String(cString: host)
            if name == "en0" { return s }
            found = found ?? s
        }
    }
    return found
}
