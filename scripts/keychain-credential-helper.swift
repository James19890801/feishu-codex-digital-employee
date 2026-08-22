import Foundation
import Security

guard CommandLine.arguments.count == 3 else {
    fputs("usage: keychain-credential-helper <service> <account>\n", stderr)
    exit(64)
}

let service = CommandLine.arguments[1]
let account = CommandLine.arguments[2]
guard !service.isEmpty, !account.isEmpty,
      service.utf8.count <= 200, account.utf8.count <= 200 else {
    fputs("invalid keychain target\n", stderr)
    exit(64)
}

let credential = FileHandle.standardInput.readDataToEndOfFile()
guard credential.count >= 8, credential.count <= 4096,
      !credential.contains(0x00), !credential.contains(0x0a), !credential.contains(0x0d) else {
    fputs("invalid credential\n", stderr)
    exit(65)
}

let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
]
let updateStatus = SecItemUpdate(
    query as CFDictionary,
    [kSecValueData as String: credential] as CFDictionary
)
if updateStatus == errSecItemNotFound {
    var item = query
    item[kSecValueData as String] = credential
    let addStatus = SecItemAdd(item as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        fputs("keychain write failed\n", stderr)
        exit(66)
    }
} else if updateStatus != errSecSuccess {
    fputs("keychain update failed\n", stderr)
    exit(66)
}
