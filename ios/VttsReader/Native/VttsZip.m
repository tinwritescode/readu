#import "VttsZip.h"
#import <zlib.h>

typedef struct {
  uint16_t method;
  uint32_t compressedSize;
  uint32_t size;
  uint32_t localHeaderOffset;
} VttsZipEntry;

@implementation VttsZip {
  NSData *_data;
  NSDictionary<NSString *, NSValue *> *_entries;
}

static BOOL Read16(NSData *data, NSUInteger at, uint16_t *out)
{
  if (at + 2 > data.length) return NO;
  const uint8_t *b = (const uint8_t *)data.bytes + at;
  *out = (uint16_t)(b[0] | b[1] << 8);
  return YES;
}

static BOOL Read32(NSData *data, NSUInteger at, uint32_t *out)
{
  if (at + 4 > data.length) return NO;
  const uint8_t *b = (const uint8_t *)data.bytes + at;
  *out = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
  return YES;
}

- (nullable instancetype)initWithData:(NSData *)data
{
  if (!(self = [super init])) return nil;
  _data = data;

  // The end-of-central-directory record sits in the last 22 + 65535 (max comment) bytes.
  NSInteger eocd = -1;
  NSInteger floor = MAX(0, (NSInteger)data.length - 22 - 65535);
  for (NSInteger at = (NSInteger)data.length - 22; at >= floor; at--) {
    uint32_t sig;
    if (Read32(data, at, &sig) && sig == 0x06054b50) {
      eocd = at;
      break;
    }
  }
  uint16_t count;
  uint32_t cursor;
  if (eocd < 0 || !Read16(data, eocd + 10, &count) || !Read32(data, eocd + 16, &cursor)) return nil;

  NSMutableDictionary *entries = [NSMutableDictionary dictionaryWithCapacity:count];
  for (uint16_t i = 0; i < count; i++) {
    uint32_t sig;
    uint16_t nameLength, extraLength, commentLength;
    VttsZipEntry entry;
    if (!Read32(data, cursor, &sig) || sig != 0x02014b50 || !Read16(data, cursor + 10, &entry.method) ||
        !Read32(data, cursor + 20, &entry.compressedSize) || !Read32(data, cursor + 24, &entry.size) ||
        !Read16(data, cursor + 28, &nameLength) || !Read16(data, cursor + 30, &extraLength) ||
        !Read16(data, cursor + 32, &commentLength) || !Read32(data, cursor + 42, &entry.localHeaderOffset) ||
        cursor + 46 + nameLength > data.length) {
      return nil;
    }
    NSString *name = [[NSString alloc] initWithData:[data subdataWithRange:NSMakeRange(cursor + 46, nameLength)]
                                           encoding:NSUTF8StringEncoding];
    if (name) entries[name] = [NSValue valueWithBytes:&entry objCType:@encode(VttsZipEntry)];
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  _entries = entries;
  return self;
}

- (NSArray<NSString *> *)paths
{
  return _entries.allKeys;
}

- (nullable NSData *)dataForPath:(NSString *)path
{
  NSValue *value = _entries[path];
  if (!value) return nil;
  VttsZipEntry entry;
  [value getValue:&entry];

  uint16_t nameLength, extraLength;
  if (!Read16(_data, entry.localHeaderOffset + 26, &nameLength) ||
      !Read16(_data, entry.localHeaderOffset + 28, &extraLength)) {
    return nil;
  }
  NSUInteger start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > _data.length) return nil;
  NSData *raw = [_data subdataWithRange:NSMakeRange(start, entry.compressedSize)];

  if (entry.method == 0) return raw;
  if (entry.method != 8) return nil;

  NSMutableData *out = [NSMutableData dataWithLength:entry.size];
  z_stream stream = {0};
  stream.next_in = (Bytef *)raw.bytes;
  stream.avail_in = (uInt)raw.length;
  stream.next_out = out.mutableBytes;
  stream.avail_out = (uInt)out.length;
  // Negative window bits: raw deflate, which is what ZIP stores (no zlib header).
  if (inflateInit2(&stream, -MAX_WBITS) != Z_OK) return nil;
  int status = inflate(&stream, Z_FINISH);
  inflateEnd(&stream);
  return status == Z_STREAM_END ? out : nil;
}

@end
