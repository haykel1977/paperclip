package money

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"strings"
)

// Currency is an ISO currency code such as "DZD" or "EUR".
type Currency string

// Money stores a monetary amount in centimes/cents and its currency.
// It never stores or computes monetary values with floating-point numbers.
type Money struct {
	Centimes int64
	Currency Currency
}

// New creates a Money value from an amount already expressed in centimes/cents.
func New(centimes int64, cur Currency) Money {
	return Money{Centimes: centimes, Currency: cur}
}

// Parse parses a decimal monetary amount into centimes/cents.
//
// Accepted grammar is intentionally strict and locale-neutral:
//
//	[-]digits[.digits]
//
// Rules:
//   - at least one digit is required before the optional decimal separator;
//   - if a decimal separator is present, it must be followed by 1 or 2 digits;
//   - one decimal digit is interpreted as tenths, e.g. "0.5" == 50 centimes;
//   - no leading '+', whitespace, thousands separators, underscores, or currency
//     suffix/prefix are accepted;
//   - overflow outside the int64 centime range is rejected.
//
// HYPOTHÈSE: because the requested examples only use '.', the parser accepts only
// '.' as decimal separator and rejects localized separators such as ','.
func Parse(s string, cur Currency) (Money, error) {
	if s == "" {
		return Money{}, errors.New("money: empty amount")
	}

	negative := false
	if s[0] == '-' {
		negative = true
		s = s[1:]
		if s == "" {
			return Money{}, errors.New("money: invalid amount format")
		}
	}

	if strings.Count(s, ".") > 1 {
		return Money{}, errors.New("money: invalid amount format")
	}

	integerPart := s
	fractionPart := ""
	if dot := strings.IndexByte(s, '.'); dot >= 0 {
		integerPart = s[:dot]
		fractionPart = s[dot+1:]
		if fractionPart == "" || len(fractionPart) > 2 {
			return Money{}, errors.New("money: invalid decimal precision")
		}
	}

	if integerPart == "" {
		return Money{}, errors.New("money: invalid amount format")
	}

	limit := uint64(math.MaxInt64)
	if negative {
		limit++
	}

	var magnitude uint64
	for _, r := range integerPart {
		if r < '0' || r > '9' {
			return Money{}, errors.New("money: invalid amount format")
		}

		digitCents := uint64(r-'0') * 100
		if magnitude > (limit-digitCents)/10 {
			return Money{}, errors.New("money: amount overflows int64 centimes")
		}
		magnitude = magnitude*10 + digitCents
	}

	fractionCents := uint64(0)
	if fractionPart != "" {
		for i, r := range fractionPart {
			if r < '0' || r > '9' {
				return Money{}, errors.New("money: invalid amount format")
			}
			if i == 0 {
				fractionCents += uint64(r-'0') * 10
			} else {
				fractionCents += uint64(r - '0')
			}
		}
	}

	if magnitude > limit-fractionCents {
		return Money{}, errors.New("money: amount overflows int64 centimes")
	}
	magnitude += fractionCents

	if negative {
		if magnitude == uint64(math.MaxInt64)+1 {
			return Money{Centimes: math.MinInt64, Currency: cur}, nil
		}
		return Money{Centimes: -int64(magnitude), Currency: cur}, nil
	}

	return Money{Centimes: int64(magnitude), Currency: cur}, nil
}

// Add returns the sum of two Money values with the same currency.
func (m Money) Add(o Money) (Money, error) {
	if m.Currency != o.Currency {
		return Money{}, errors.New("money: currency mismatch")
	}

	if (o.Centimes > 0 && m.Centimes > math.MaxInt64-o.Centimes) ||
		(o.Centimes < 0 && m.Centimes < math.MinInt64-o.Centimes) {
		return Money{}, errors.New("money: addition overflows int64 centimes")
	}

	return Money{Centimes: m.Centimes + o.Centimes, Currency: m.Currency}, nil
}

// Sub returns the difference of two Money values with the same currency.
func (m Money) Sub(o Money) (Money, error) {
	if m.Currency != o.Currency {
		return Money{}, errors.New("money: currency mismatch")
	}

	if (o.Centimes < 0 && m.Centimes > math.MaxInt64+o.Centimes) ||
		(o.Centimes > 0 && m.Centimes < math.MinInt64+o.Centimes) {
		return Money{}, errors.New("money: subtraction overflows int64 centimes")
	}

	return Money{Centimes: m.Centimes - o.Centimes, Currency: m.Currency}, nil
}

// Mul multiplies Money by an integer quantity.
// HYPOTHÈSE: the requested API has no error return for overflow, so this method
// uses Go's int64 multiplication semantics. Callers handling untrusted huge
// quantities should validate ranges before calling Mul.
func (m Money) Mul(qty int64) Money {
	return Money{Centimes: m.Centimes * qty, Currency: m.Currency}
}

// Allocate splits Money proportionally according to ratios while preserving the
// exact total: the returned parts always sum to m when no error is returned.
//
// Remainder centimes are distributed deterministically to the earliest parts:
// +1 for positive remainder, -1 for negative remainder.
//
// HYPOTHÈSE: the specification only declares empty ratios and sum(ratios) <= 0
// invalid. Therefore individual zero or negative ratios are not rejected when
// the total ratio sum is positive; this preserves the requested API contract,
// although business layers may choose to forbid such ratios separately.
func (m Money) Allocate(ratios []int) ([]Money, error) {
	if len(ratios) == 0 {
		return nil, errors.New("money: ratios cannot be empty")
	}

	var ratioSum int64
	for _, ratio := range ratios {
		if ratio > 0 && ratioSum > math.MaxInt64-int64(ratio) {
			return nil, errors.New("money: ratio sum overflows int64")
		}
		if ratio < 0 && ratioSum < math.MinInt64-int64(ratio) {
			return nil, errors.New("money: ratio sum overflows int64")
		}
		ratioSum += int64(ratio)
	}
	if ratioSum <= 0 {
		return nil, errors.New("money: ratio sum must be positive")
	}

	parts := make([]Money, len(ratios))
	allocated := int64(0)
	amount := big.NewInt(m.Centimes)
	denominator := big.NewInt(ratioSum)

	for i, ratio := range ratios {
		numerator := new(big.Int).Mul(amount, big.NewInt(int64(ratio)))
		quotient := new(big.Int).Quo(numerator, denominator)
		if !quotient.IsInt64() {
			return nil, errors.New("money: allocated part overflows int64 centimes")
		}

		partCentimes := quotient.Int64()
		if (partCentimes > 0 && allocated > math.MaxInt64-partCentimes) ||
			(partCentimes < 0 && allocated < math.MinInt64-partCentimes) {
			return nil, errors.New("money: allocated total overflows int64 centimes")
		}
		allocated += partCentimes
		parts[i] = Money{Centimes: partCentimes, Currency: m.Currency}
	}

	remainder := m.Centimes - allocated
	step := int64(1)
	if remainder < 0 {
		step = -1
		remainder = -remainder
	}

	for i := int64(0); i < remainder; i++ {
		idx := int(i % int64(len(parts)))
		if (step > 0 && parts[idx].Centimes == math.MaxInt64) ||
			(step < 0 && parts[idx].Centimes == math.MinInt64) {
			return nil, errors.New("money: remainder distribution overflows int64 centimes")
		}
		parts[idx].Centimes += step
	}

	return parts, nil
}

// String formats Money as a fixed two-decimal amount followed by the currency.
func (m Money) String() string {
	var magnitude uint64
	if m.Centimes < 0 {
		magnitude = uint64(-(m.Centimes + 1)) + 1
	} else {
		magnitude = uint64(m.Centimes)
	}

	units := magnitude / 100
	cents := magnitude % 100
	sign := ""
	if m.Centimes < 0 {
		sign = "-"
	}

	return fmt.Sprintf("%s%d.%02d %s", sign, units, cents, m.Currency)
}
