#include <string>
#include <vector>
#include <opencv2/opencv.hpp>

// Decoder primitives - take grayscale images only
// formats: empty vector = all symbologies (default); otherwise allowlist of canonical names
std::string decode_zbar(const cv::Mat& grayscale,
                        const std::vector<std::string>& formats);
std::string decode_zxing(const cv::Mat& grayscale,
                         const std::vector<std::string>& formats);

// Projection decoder for noisy / low-resolution 1D codes. Takes the original
// (BGR or grayscale) crop of a single barcode: aligns the bars, averages bands
// into 1D profiles, decodes each profile with ZBar and ZXing and votes.
struct ProjectionOptions {
  int minVotes = 3;    // profile reads of the same value needed to accept it
  int stripWidth = 0;  // band height in px; 0 = auto (12% of bar height, 8-48 px)
};
std::string decode_projection(const cv::Mat& bgr,
                              const std::vector<std::string>& formats,
                              const ProjectionOptions& opts);

// Preprocessing primitives - convert BGR to preprocessed grayscale
cv::Mat preprocess_original(const cv::Mat& bgr);
cv::Mat preprocess_histogram(const cv::Mat& bgr);
cv::Mat preprocess_otsu(const cv::Mat& bgr);
