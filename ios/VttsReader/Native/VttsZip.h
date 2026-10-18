#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Reads entries of a ZIP archive held in memory (EPUB and DOCX are ZIPs).
/// Handles stored and deflated entries; ZIP64 and encryption are not supported.
@interface VttsZip : NSObject

- (nullable instancetype)initWithData:(NSData *)data;

@property (nonatomic, readonly) NSArray<NSString *> *paths;

- (nullable NSData *)dataForPath:(NSString *)path;

@end

NS_ASSUME_NONNULL_END
