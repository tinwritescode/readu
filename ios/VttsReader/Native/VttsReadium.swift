// Reads EPUB and PDF files with Readium (https://github.com/readium/swift-toolkit).
// Called from VttsDocuments.m; the result is a PickedDocument in src/features/import/extractText.ts.

import Foundation
import ReadiumShared
import ReadiumStreamer

@objc(VttsReadium)
final class VttsReadium: NSObject {
  private static let httpClient = DefaultHTTPClient()
  private static let assetRetriever = AssetRetriever(httpClient: httpClient)
  private static let opener = PublicationOpener(
    parser: DefaultPublicationParser(
      httpClient: httpClient,
      assetRetriever: assetRetriever,
      pdfFactory: DefaultPDFDocumentFactory()
    )
  )

  enum ReadError: Error {
    case notAFile
    case protected
  }

  @objc static func read(_ url: URL, completion: @escaping ([String: Any]?, Error?) -> Void) {
    Task {
      do {
        completion(try await read(url), nil)
      } catch {
        completion(nil, error)
      }
    }
  }

  private static func read(_ url: URL) async throws -> [String: Any] {
    guard let file = FileURL(url: url) else { throw ReadError.notAFile }
    let asset = try await assetRetriever.retrieve(url: file).get()
    let publication = try await opener.open(asset: asset, allowUserInteraction: false).get()
    // DRM-protected books (LCP, Apple Books) open, but their resources can't be read.
    if publication.isRestricted { throw ReadError.protected }

    // EPUB yields one element per paragraph or heading; PDF one per page.
    let blocks = await publication.content()?.elements()
      .compactMap { ($0 as? TextContentElement)?.text } ?? []
    let isPDF = publication.conforms(to: .pdf)
    return [
      "name": url.lastPathComponent,
      "kind": isPDF ? "pdf" : "epub",
      "title": publication.metadata.title ?? NSNull(),
      isPDF ? "pages" : "paragraphs": blocks,
      "cover": await saveCover(of: publication) ?? NSNull(),
    ]
  }

  /// The EPUB's cover image, or for a PDF its first page, saved as a JPEG in
  /// `coversDirectory`. Returns the file name, since the app container path changes between installs.
  private static func saveCover(of publication: Publication) async -> String? {
    // 3× the largest size the library shows (64pt wide at 2:3).
    guard let image = try? await publication.coverFitting(maxSize: CGSize(width: 192, height: 288)).get(),
          let data = image.jpegData(compressionQuality: 0.8)
    else { return nil }
    let name = "\(UUID().uuidString).jpg"
    do {
      try FileManager.default.createDirectory(at: coversDirectory, withIntermediateDirectories: true)
      try data.write(to: coversDirectory.appendingPathComponent(name))
      return name
    } catch {
      return nil
    }
  }

  @objc static var coversDirectory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("covers", isDirectory: true)
  }
}
