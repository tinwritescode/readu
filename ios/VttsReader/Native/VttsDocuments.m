// Files app picker for TXT, PDF, EPUB and DOCX, and the library file on disk.
// EPUB and PDF go through Readium (VttsReadium.swift). Word and TXT are read here.
// Native code only gets the raw text out; JS turns it into readable text.
// JS side: src/features/import/DocumentImporter.ts, src/features/import/extractText.ts

#import <React/RCTBridgeModule.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import "VttsReader-Swift.h"
#import "VttsZip.h"

@interface VttsDocuments : NSObject <RCTBridgeModule, UIDocumentPickerDelegate>
@end

@implementation VttsDocuments {
  RCTPromiseResolveBlock _resolve;
  RCTPromiseRejectBlock _reject;
}

RCT_EXPORT_MODULE(VttsDocuments)

static UTType *DocxType(void)
{
  return [UTType typeWithIdentifier:@"org.openxmlformats.wordprocessingml.document"];
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

RCT_EXPORT_METHOD(pickDocument:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  if (_resolve != nil) {
    reject(@"E_BUSY", @"A document picker is already open", nil);
    return;
  }
  UIViewController *presenter = RCTPresentedViewController();
  if (presenter == nil) {
    reject(@"E_NO_VIEW", @"No view controller to present the picker from", nil);
    return;
  }
  _resolve = resolve;
  _reject = reject;
  UIDocumentPickerViewController *picker =
      [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[ UTTypePlainText, UTTypePDF, UTTypeEPUB, DocxType() ]
                                                                  asCopy:YES];
  picker.delegate = self;
  [presenter presentViewController:picker animated:YES completion:nil];
}

static NSString *KindOf(NSURL *url)
{
  UTType *type = [UTType typeWithFilenameExtension:url.pathExtension];
  if ([type conformsToType:UTTypePDF]) return @"pdf";
  if ([type conformsToType:UTTypeEPUB]) return @"epub";
  if ([type conformsToType:DocxType()]) return @"docx";
  return @"txt";
}

/// The XML entries of a DOCX, keyed by path inside the archive.
static NSDictionary *XMLEntries(NSURL *url, NSError **error)
{
  NSData *data = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:error];
  VttsZip *zip = data ? [[VttsZip alloc] initWithData:data] : nil;
  if (!zip) return nil;
  NSMutableDictionary *files = [NSMutableDictionary new];
  for (NSString *path in zip.paths) {
    if (![path.pathExtension.lowercaseString isEqualToString:@"xml"]) continue;
    NSData *entry = [zip dataForPath:path];
    NSString *text = entry ? [[NSString alloc] initWithData:entry encoding:NSUTF8StringEncoding] : nil;
    if (text) files[path] = text;
  }
  return files;
}

static NSDictionary *ReadDocument(NSURL *url, NSError **error)
{
  NSString *kind = KindOf(url);
  NSString *name = url.lastPathComponent ?: @"Untitled";
  if ([kind isEqualToString:@"txt"]) {
    NSString *text = [NSString stringWithContentsOfURL:url usedEncoding:nil error:error];
    return text ? @{@"name" : name, @"kind" : kind, @"text" : text} : nil;
  }
  NSDictionary *files = XMLEntries(url, error);
  return files ? @{@"name" : name, @"kind" : kind, @"files" : files} : nil;
}

static NSURL *LibraryURL(void)
{
  NSURL *dir = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
  [NSFileManager.defaultManager createDirectoryAtURL:dir withIntermediateDirectories:YES attributes:nil error:nil];
  return [dir URLByAppendingPathComponent:@"library.json"];
}

RCT_EXPORT_METHOD(loadLibrary:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *json = [NSString stringWithContentsOfURL:LibraryURL() encoding:NSUTF8StringEncoding error:nil];
  resolve(json ?: [NSNull null]);
}

RCT_EXPORT_METHOD(saveLibrary:(NSString *)json
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSError *error = nil;
  if (![json writeToURL:LibraryURL() atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
    reject(@"E_WRITE", error.localizedDescription ?: @"Could not save library", error);
    return;
  }
  resolve(nil);
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  NSURL *url = urls.firstObject;
  RCTPromiseResolveBlock resolve = _resolve;
  RCTPromiseRejectBlock reject = _reject;
  [self clear];
  // Reading a large file takes a while; keep it off the main thread.
  void (^settle)(NSDictionary *, NSError *) = ^(NSDictionary *document, NSError *error) {
    if (document) {
      resolve(document);
    } else {
      reject(@"E_READ", @"This file could not be opened. It may be damaged or protected.", error);
    }
  };
  NSString *kind = KindOf(url);
  if ([kind isEqualToString:@"epub"] || [kind isEqualToString:@"pdf"]) {
    [VttsReadium read:url completion:settle];
    return;
  }
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    NSDictionary *document = ReadDocument(url, &error);
    settle(document, error);
  });
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller
{
  RCTPromiseResolveBlock resolve = _resolve;
  [self clear];
  resolve([NSNull null]);
}

- (void)clear
{
  _resolve = nil;
  _reject = nil;
}

@end
