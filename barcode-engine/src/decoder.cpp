/*
https://www.learnopencv.com/barcode-and-qr-code-scanner-using-zbar-and-opencv/
*/

#include <algorithm>
#include <climits>
#include <cmath>
#include <string>
#include <vector>
#include <map>
#include <zbar.h>
#include <ZXing/ReadBarcode.h>
#include <ZXing/ReaderOptions.h>
#include <ZXing/BarcodeFormat.h>

#include <opencv2/core.hpp>
#include <opencv2/imgproc/imgproc.hpp>

#include "decoder.h"


using namespace std;
using namespace cv;
using namespace zbar;

// Canonical format name → ZBar symbology
static const std::map<std::string, zbar_symbol_type_t>& zbarFormatMap() {
  static const std::map<std::string, zbar_symbol_type_t> m = {
    {"UPCA",       ZBAR_UPCA},
    {"UPCE",       ZBAR_UPCE},
    {"EAN13",      ZBAR_EAN13},
    {"EAN8",       ZBAR_EAN8},
    {"Code128",    ZBAR_CODE128},
    {"Code39",     ZBAR_CODE39},
    {"Code93",     ZBAR_CODE93},
    {"Codabar",    ZBAR_CODABAR},
    {"ITF",        ZBAR_I25},
    {"QRCode",     ZBAR_QRCODE},
    {"PDF417",     ZBAR_PDF417},
    {"DataBar",    ZBAR_DATABAR}
  };
  return m;
}

// Canonical format name → ZXing BarcodeFormat
static const std::map<std::string, ZXing::BarcodeFormat>& zxingFormatMap() {
  static const std::map<std::string, ZXing::BarcodeFormat> m = {
    {"UPCA",        ZXing::BarcodeFormat::UPCA},
    {"UPCE",        ZXing::BarcodeFormat::UPCE},
    {"EAN13",       ZXing::BarcodeFormat::EAN13},
    {"EAN8",        ZXing::BarcodeFormat::EAN8},
    {"Code128",     ZXing::BarcodeFormat::Code128},
    {"Code39",      ZXing::BarcodeFormat::Code39},
    {"Code93",      ZXing::BarcodeFormat::Code93},
    {"Codabar",     ZXing::BarcodeFormat::Codabar},
    {"ITF",         ZXing::BarcodeFormat::ITF},
    {"QRCode",      ZXing::BarcodeFormat::QRCode},
    {"PDF417",      ZXing::BarcodeFormat::PDF417},
    {"DataMatrix",  ZXing::BarcodeFormat::DataMatrix},
    {"Aztec",       ZXing::BarcodeFormat::Aztec},
    {"DataBar",     ZXing::BarcodeFormat::DataBar}
  };
  return m;
}


// One decoded symbol. Corner order matches the node's legacy convention:
// (x2,y2) top-left, (x1,y1) top-right, (x4,y4) bottom-right, (x3,y3) bottom-left.
struct Decoded {
  string type;
  string data;
  int quality = 0;
  int x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0, x4 = 0, y4 = 0;
};

static string toJson(const vector<Decoded>& objs) {
  string result = "{\"results\": [";
  bool first = true;
  for (const auto& o : objs) {
    if (!first) result += ",";
    first = false;
    result += "{\"type\": \"" + o.type +
        "\", \"data\": \"" + o.data +
        "\", \"quality\": " + to_string(o.quality) +
        ", \"points\": {\"x1\": " + to_string(o.x1) +
        ", \"y1\": " + to_string(o.y1) +
        ", \"x2\": " + to_string(o.x2) +
        ", \"y2\": " + to_string(o.y2) +
        ", \"x3\": " + to_string(o.x3) +
        ", \"y3\": " + to_string(o.y3) +
        ", \"x4\": " + to_string(o.x4) +
        ", \"y4\": " + to_string(o.y4) +
        "}}";
  }
  result += "]}";
  return result;
}

// ZBar scan. rowsOnly skips vertical scan lines (used on 1D profile images).
static vector<Decoded> zbarSymbols(const Mat& gray, const vector<string>& formats, bool rowsOnly) {
  ImageScanner scanner;

  if (formats.empty()) {
    // Default behavior: rely on ZBar defaults but explicitly enable
    // UPC-A so codes are reported as UPC-A (12 digits) rather than
    // EAN-13 with a leading 0.
    scanner.set_config(ZBAR_QRCODE, ZBAR_CFG_ENABLE, 1);
    scanner.set_config(ZBAR_UPCA,   ZBAR_CFG_ENABLE, 1);
  } else {
    // Allowlist mode: disable everything, then enable mapped symbologies
    scanner.set_config(static_cast<zbar_symbol_type_t>(0), ZBAR_CFG_ENABLE, 0);
    const auto& fmtMap = zbarFormatMap();
    for (const auto& name : formats) {
      auto it = fmtMap.find(name);
      if (it != fmtMap.end()) {
        scanner.set_config(it->second, ZBAR_CFG_ENABLE, 1);
      }
    }
  }
  if (rowsOnly) {
    scanner.set_config(static_cast<zbar_symbol_type_t>(0), ZBAR_CFG_X_DENSITY, 0);
  }

  Image image(gray.cols, gray.rows, "Y800", (uchar *)gray.data, gray.cols * gray.rows);
  scanner.scan(image);

  vector<Decoded> out;
  for (Image::SymbolIterator symbol = image.symbol_begin(); symbol != image.symbol_end(); ++symbol) {
    Decoded d;
    d.type = symbol->get_type_name();
    d.data = symbol->get_data();
    d.quality = symbol->get_quality();
    d.x3 = symbol->get_location_x(0); d.y3 = symbol->get_location_y(0);
    d.x4 = symbol->get_location_x(1); d.y4 = symbol->get_location_y(1);
    d.x1 = symbol->get_location_x(2); d.y1 = symbol->get_location_y(2);
    d.x2 = symbol->get_location_x(3); d.y2 = symbol->get_location_y(3);
    out.push_back(d);
  }
  return out;
}

// ZXing scan. TryHarder is always on — fast mode produced false positives on
// bar-end and text-strip scan lines. rowsOnly disables the rotated pass.
static vector<Decoded> zxingSymbols(const Mat& gray, const vector<string>& formats, bool rowsOnly) {
  ZXing::ReaderOptions hints;
  hints.setTryHarder(true);
  hints.setTryRotate(!rowsOnly);

  if (!formats.empty()) {
    ZXing::BarcodeFormats wanted = ZXing::BarcodeFormat::None;
    const auto& fmtMap = zxingFormatMap();
    for (const auto& name : formats) {
      auto it = fmtMap.find(name);
      if (it != fmtMap.end()) {
        wanted |= it->second;
      }
    }
    hints.setFormats(wanted);
  }

  ZXing::ImageView imageView(gray.data, gray.cols, gray.rows, ZXing::ImageFormat::Lum);
  ZXing::Results results = ZXing::ReadBarcodes(imageView, hints);

  vector<Decoded> out;
  for (const auto& r : results) {
    Decoded d;
    d.type = ZXing::ToString(r.format());
    d.data = r.text();
    d.quality = r.lineCount();
    auto p = r.position();
    if (p.size() >= 4) {
      d.x2 = p[0].x; d.y2 = p[0].y;  // top-left
      d.x1 = p[1].x; d.y1 = p[1].y;  // top-right
      d.x4 = p[2].x; d.y4 = p[2].y;  // bottom-right
      d.x3 = p[3].x; d.y3 = p[3].y;  // bottom-left
    }
    out.push_back(d);
  }
  return out;
}

// Simple ZBar decoder - takes grayscale image only
string decode_zbar(const cv::Mat& grayscale,
                   const std::vector<std::string>& formats)
{
  if (grayscale.empty()) {
    return "{\"results\": []}";
  }
  if (grayscale.channels() != 1) {
    return "{\"error\": \"Expected grayscale image (1 channel)\"}";
  }
  return toJson(zbarSymbols(grayscale, formats, false));
}

// Simple ZXing decoder - takes grayscale image only
string decode_zxing(const cv::Mat& grayscale,
                    const std::vector<std::string>& formats)
{
  if (grayscale.empty()) {
    return "{\"results\": []}";
  }
  if (grayscale.channels() != 1) {
    return "{\"error\": \"Expected grayscale image (1 channel)\"}";
  }
  return toJson(zxingSymbols(grayscale, formats, false));
}

// ---------------------------------------------------------------------------
// Projection decoder
// ---------------------------------------------------------------------------

namespace {

constexpr int kUpsample = 4;      // profile samples per source pixel
constexpr int kProfileRows = 12;  // height of the synthetic profile image
constexpr int kQuietZone = 40;    // white margin (px) on each side of the profile
constexpr double kSharpenSigma = 1.2;   // unsharp mask on the profile, second read
constexpr double kSharpenAmount = 1.5;

// Dominant gradient direction in degrees, (-90, 90]. Bars run perpendicular to it.
double gradientAngle(const Mat& gray) {
  Mat gx, gy;
  Sobel(gray, gx, CV_32F, 1, 0);
  Sobel(gray, gy, CV_32F, 0, 1);
  double jxx = mean(gx.mul(gx))[0];
  double jyy = mean(gy.mul(gy))[0];
  double jxy = mean(gx.mul(gy))[0];
  return 0.5 * atan2(2 * jxy, jxx - jyy) * 180.0 / CV_PI;
}

// 2x3 affine that turns the image so the bars stand vertical (reading axis
// horizontal). Includes a 90° turn when the code is closer to that orientation.
Mat alignmentTransform(const Mat& gray, Size& outSize) {
  double angle = gradientAngle(gray);
  Mat pre = Mat::eye(3, 3, CV_64F);
  outSize = gray.size();

  if (fabs(angle) > 45.0) {
    // 90° clockwise: (x, y) -> (h-1-y, x); the gradient turns by +90°
    pre = (Mat_<double>(3, 3) << 0, -1, gray.rows - 1, 1, 0, 0, 0, 0, 1);
    outSize = Size(gray.rows, gray.cols);
    angle += 90.0;
    if (angle > 90.0) angle -= 180.0;
  }

  Mat rot = getRotationMatrix2D(Point2f(outSize.width / 2.0f, outSize.height / 2.0f), angle, 1.0);
  Mat rot3 = Mat::eye(3, 3, CV_64F);
  rot.copyTo(rot3(Rect(0, 0, 3, 2)));
  Mat full = rot3 * pre;
  return full(Rect(0, 0, 3, 2)).clone();
}

// 1xN float profile -> decodable image: normalized, upsampled, tiled, quiet zones
Mat profileImage(const Mat& profile) {
  double lo, hi;
  minMaxLoc(profile, &lo, &hi);
  Mat norm = (profile - lo) * (255.0 / max(hi - lo, 1e-6));
  Mat up, row, img;
  resize(norm, up, Size(profile.cols * kUpsample, 1), 0, 0, INTER_CUBIC);
  up.convertTo(row, CV_8U);
  repeat(row, kProfileRows, 1, img);
  copyMakeBorder(img, img, 0, 0, kQuietZone, kQuietZone, BORDER_CONSTANT, Scalar(255));
  return img;
}

struct Candidate {
  string type;
  int votes = 0;
  // Extent in aligned-image coordinates
  int xMin = INT_MAX, xMax = 0, yMin = INT_MAX, yMax = 0;
};

// Gray plus each color plane: chromatic aberration often leaves one plane sharp
vector<Mat> channelPlanes(const Mat& bgr) {
  vector<Mat> planes{ preprocess_original(bgr) };
  if (bgr.channels() >= 3) {
    vector<Mat> split3;
    split(bgr, split3);
    planes.insert(planes.end(), split3.begin(), split3.begin() + 3);
  }
  return planes;
}

}  // namespace

string decode_projection(const cv::Mat& bgr,
                         const std::vector<std::string>& formats,
                         const ProjectionOptions& opts)
{
  vector<Mat> planes = channelPlanes(bgr);
  if (planes.empty() || planes[0].empty()) {
    return "{\"results\": []}";
  }

  Size aligned;
  Mat M = alignmentTransform(planes[0], aligned);
  const int w = aligned.width, h = aligned.height;
  const int stripWidth = max(1, opts.stripWidth);

  map<string, Candidate> votes;  // keyed by decoded value
  for (const Mat& plane : planes) {
    Mat img;
    warpAffine(plane, img, M, aligned, INTER_LINEAR, BORDER_REPLICATE);

    for (int sw : { stripWidth, 2 * stripWidth }) {
      sw = min(sw, h);
      const int step = max(1, sw / 2);
      for (int y0 = 0; y0 + sw <= h; y0 += step) {
        Mat profile, blurred;
        reduce(img.rowRange(y0, y0 + sw), profile, 0, REDUCE_AVG, CV_32F);
        GaussianBlur(profile, blurred, Size(0, 0), kSharpenSigma);
        Mat sharpened = profile + kSharpenAmount * (profile - blurred);

        // Read the plain and the sharpened profile with both engines
        vector<Decoded> reads;
        for (const Mat& p : { profile, sharpened }) {
          Mat pimg = profileImage(p);
          for (auto* scan : { &zbarSymbols, &zxingSymbols }) {
            vector<Decoded> r = scan(pimg, formats, true);
            reads.insert(reads.end(), r.begin(), r.end());
          }
        }

        for (const Decoded& d : reads) {
          Candidate& c = votes[d.data];
          if (c.votes == 0) c.type = d.type;
          c.votes++;
          for (int x : { d.x1, d.x2, d.x3, d.x4 }) {
            int ax = min(max((x - kQuietZone) / kUpsample, 0), w - 1);
            c.xMin = min(c.xMin, ax);
            c.xMax = max(c.xMax, ax);
          }
          c.yMin = min(c.yMin, y0);
          c.yMax = max(c.yMax, y0 + sw - 1);
        }
      }
    }
  }

  // Keep values with enough agreement, strongest first
  vector<pair<string, Candidate>> accepted;
  for (const auto& kv : votes) {
    if (kv.second.votes >= opts.minVotes) accepted.push_back(kv);
  }
  sort(accepted.begin(), accepted.end(),
       [](const auto& a, const auto& b) { return a.second.votes > b.second.votes; });

  // Map the extent back to original image coordinates
  Mat Minv;
  invertAffineTransform(M, Minv);
  auto back = [&](double x, double y, int& ox, int& oy) {
    double bx = Minv.at<double>(0, 0) * x + Minv.at<double>(0, 1) * y + Minv.at<double>(0, 2);
    double by = Minv.at<double>(1, 0) * x + Minv.at<double>(1, 1) * y + Minv.at<double>(1, 2);
    ox = min(max(static_cast<int>(lround(bx)), 0), bgr.cols - 1);
    oy = min(max(static_cast<int>(lround(by)), 0), bgr.rows - 1);
  };

  vector<Decoded> out;
  for (const auto& kv : accepted) {
    const Candidate& c = kv.second;
    Decoded d;
    d.type = c.type;
    d.data = kv.first;
    d.quality = c.votes;
    back(c.xMin, c.yMin, d.x2, d.y2);  // top-left
    back(c.xMax, c.yMin, d.x1, d.y1);  // top-right
    back(c.xMax, c.yMax, d.x4, d.y4);  // bottom-right
    back(c.xMin, c.yMax, d.x3, d.y3);  // bottom-left
    out.push_back(d);
  }
  return toJson(out);
}

// Preprocessing primitive: BGR to Grayscale
Mat preprocess_original(const Mat& bgr) {
  if (bgr.empty()) {
    return Mat();
  }

  Mat gray;

  // Convert based on input channels
  if (bgr.channels() == 1) {
    // Already grayscale
    gray = bgr.clone();
  } else if (bgr.channels() == 3) {
    cvtColor(bgr, gray, COLOR_BGR2GRAY);
  } else if (bgr.channels() == 4) {
    cvtColor(bgr, gray, COLOR_BGRA2GRAY);
  } else {
    // Unsupported channel count
    return Mat();
  }

  return gray;
}

// Preprocessing primitive: BGR to Histogram Equalization
Mat preprocess_histogram(const Mat& bgr) {
  if (bgr.empty()) {
    return Mat();
  }

  Mat gray, result;

  // Convert to grayscale first
  if (bgr.channels() == 1) {
    gray = bgr.clone();
  } else if (bgr.channels() == 3) {
    cvtColor(bgr, gray, COLOR_BGR2GRAY);
  } else if (bgr.channels() == 4) {
    cvtColor(bgr, gray, COLOR_BGRA2GRAY);
  } else {
    return Mat();
  }

  // Apply histogram equalization
  equalizeHist(gray, result);
  return result;
}

// Preprocessing primitive: BGR to Otsu Threshold
Mat preprocess_otsu(const Mat& bgr) {
  if (bgr.empty()) {
    return Mat();
  }

  Mat gray, histEq, result;

  // Convert to grayscale first
  if (bgr.channels() == 1) {
    gray = bgr.clone();
  } else if (bgr.channels() == 3) {
    cvtColor(bgr, gray, COLOR_BGR2GRAY);
  } else if (bgr.channels() == 4) {
    cvtColor(bgr, gray, COLOR_BGRA2GRAY);
  } else {
    return Mat();
  }

  // First apply histogram equalization
  equalizeHist(gray, histEq);

  // Then apply Otsu's thresholding
  threshold(histEq, result, 0, 255, THRESH_BINARY | THRESH_OTSU);

  return result;
}
