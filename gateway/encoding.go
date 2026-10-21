package main

import (
	"bytes"
	"compress/gzip"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Content-encoding of static files. Every file a dist serves is write-once, so
// the build compresses it exactly once, when it is published, into `<file>.br`
// and `<file>.gz` beside it (web-artifacts `core/internal/precompress.ts`). The
// gateway never compresses a file per request — it only picks the sidecar the
// client accepts, the nginx gzip_static / brotli_static model. The one dynamic
// body, the head-spliced shell, is gzipped on the fly (serveBytes).

// encodings in preference order: brotli is ~10–30 % smaller than gzip on the
// fleet's bytes. Browsers advertise br only in secure contexts (localhost
// included), so gzip is what a plain-http client gets.
var encodings = []struct {
	token, ext string
}{
	{"br", ".br"},
	{"gzip", ".gz"},
}

// acceptsEncoding reports whether an Accept-Encoding header admits token: named
// with a non-zero q, or covered by `*`, and never refused by an explicit `q=0`.
func acceptsEncoding(header, token string) bool {
	star := false
	for _, part := range strings.Split(header, ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		name = strings.ToLower(strings.TrimSpace(name))
		q := 1.0
		for _, p := range strings.Split(params, ";") {
			k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
			if ok && strings.TrimSpace(k) == "q" {
				if f, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil {
					q = f
				}
			}
		}
		switch name {
		case token:
			return q > 0
		case "*":
			star = q > 0
		}
	}
	return star
}

// contentTypeOf is the ORIGINAL file's type, by extension: an encoded body
// must never be sniffed (http.ServeContent would read the compressed bytes).
// A type the table does not know is served as opaque bytes, which is what the
// browser host's PGlite `.data` is.
func contentTypeOf(file string) string {
	if t := mime.TypeByExtension(filepath.Ext(file)); t != "" {
		return t
	}
	return "application/octet-stream"
}

// serveStaticFile serves one dist file, from its precompressed sidecar when the
// build wrote one and the client accepts it, else as-is (http.ServeFile).
//
// A file with sidecars varies by Accept-Encoding whichever body is chosen, so
// a shared cache never hands a gzip body to a client that asked for identity.
// A Range request is always served identity: a byte range of an encoded body
// is a range of the encoding, which no client asking for a slice means (the
// media that use ranges are not compressible and carry no sidecar anyway).
func serveStaticFile(w http.ResponseWriter, r *http.Request, file string) {
	accept := r.Header.Get("Accept-Encoding")
	varies := false
	for _, enc := range encodings {
		sidecar := file + enc.ext
		info, err := os.Stat(sidecar)
		if err != nil || info.IsDir() {
			continue
		}
		varies = true
		if r.Header.Get("Range") != "" || !acceptsEncoding(accept, enc.token) {
			continue
		}
		f, err := os.Open(sidecar)
		if err != nil {
			continue // vanished since the stat: serve what is left
		}
		defer f.Close()
		h := w.Header()
		h.Add("Vary", "Accept-Encoding")
		h.Set("Content-Type", contentTypeOf(file))
		h.Set("Content-Encoding", enc.token)
		http.ServeContent(w, r, filepath.Base(file), info.ModTime(), f)
		return
	}
	if varies {
		w.Header().Add("Vary", "Accept-Encoding")
	}
	http.ServeFile(w, r, file)
}

// gzipMinBytes: below this a gzip body saves less than its own framing costs.
const gzipMinBytes = 1024

// serveBytes serves a body built for this request (the head-spliced shell),
// gzipped on the fly when the client accepts it. etag is the identity body's
// validator; the encoded body gets its own (`-gzip` suffix), since a validator
// names exact bytes.
func serveBytes(w http.ResponseWriter, r *http.Request, name, etag string, body []byte) {
	h := w.Header()
	h.Add("Vary", "Accept-Encoding")
	if len(body) >= gzipMinBytes && r.Header.Get("Range") == "" && acceptsEncoding(r.Header.Get("Accept-Encoding"), "gzip") {
		var buf bytes.Buffer
		zw, _ := gzip.NewWriterLevel(&buf, gzip.BestSpeed)
		_, _ = zw.Write(body) // writes to a bytes.Buffer cannot fail
		_ = zw.Close()
		h.Set("Content-Type", contentTypeOf(name))
		h.Set("Content-Encoding", "gzip")
		h.Set("ETag", strings.TrimSuffix(etag, `"`)+`-gzip"`)
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(buf.Bytes()))
		return
	}
	h.Set("ETag", etag)
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(body))
}
