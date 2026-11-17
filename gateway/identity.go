package main

import (
	"encoding/json"
	"net/http"
)

// productName is the product's own name (framework/product-name's
// PRODUCT_NAME): what GET /gateway/identity answers as `product`.
const productName = "equin"

// gatewayIdentity is GET /gateway/identity: whose gateway answers on this
// port. `./equin start` reads it to tell its own gateway (same product, uid
// and data root) from another account's equin or an unrelated server on the
// port, and the health read reads legacyListen (null when there is no
// -legacy-listen) to say whether the old port is still held. Owner-only,
// like every /gateway/* route.
type gatewayIdentity struct {
	Product      string              `json:"product"`
	UID          int                 `json:"uid"`
	DataDir      string              `json:"dataDir"`
	Port         int                 `json:"port"`
	LegacyListen *legacyListenStatus `json:"legacyListen"`
}

func (p *Proxy) serveIdentity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET", http.StatusMethodNotAllowed)
		return
	}
	if p.identity == nil {
		// main always sets it: a Proxy without one is a wiring bug.
		http.Error(w, "this gateway was wired without an identity", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(p.identity)
}
