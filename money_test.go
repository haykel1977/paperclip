package money

import (
	"reflect"
	"testing"
)

func mustSumParts(t *testing.T, parts []Money, cur Currency) Money {
	t.Helper()

	sum := New(0, cur)
	for _, part := range parts {
		var err error
		sum, err = sum.Add(part)
		if err != nil {
			t.Fatalf("unexpected sum error: %v", err)
		}
	}
	return sum
}

func TestParse(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		cur     Currency
		want    Money
		wantErr bool
	}{
		{
			name:  "two decimals",
			input: "1234.56",
			cur:   "DZD",
			want:  New(123456, "DZD"),
		},
		{
			name:  "negative two decimals",
			input: "-12.00",
			cur:   "EUR",
			want:  New(-1200, "EUR"),
		},
		{
			name:  "one decimal padded to centimes",
			input: "0.5",
			cur:   "DZD",
			want:  New(50, "DZD"),
		},
		{
			name:  "integer amount",
			input: "42",
			cur:   "EUR",
			want:  New(4200, "EUR"),
		},
		{
			name:  "zero",
			input: "0.00",
			cur:   "DZD",
			want:  New(0, "DZD"),
		},
		{
			name:    "three decimals rejected",
			input:   "12.345",
			cur:     "DZD",
			wantErr: true,
		},
		{
			name:    "letters rejected",
			input:   "12a.34",
			cur:     "DZD",
			wantErr: true,
		},
		{
			name:    "empty string rejected",
			input:   "",
			cur:     "DZD",
			wantErr: true,
		},
		{
			name:    "missing integer part rejected",
			input:   ".50",
			cur:     "DZD",
			wantErr: true,
		},
		{
			name:    "missing decimal digits rejected",
			input:   "1.",
			cur:     "DZD",
			wantErr: true,
		},
		{
			name:    "multiple decimal separators rejected",
			input:   "1.2.3",
			cur:     "DZD",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Parse(tt.input, tt.cur)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Parse(%q, %q) error = %v, wantErr %v", tt.input, tt.cur, err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("Parse(%q, %q) = %+v, want %+v", tt.input, tt.cur, got, tt.want)
			}
		})
	}
}

func TestAddSub(t *testing.T) {
	tests := []struct {
		name    string
		left    Money
		right   Money
		op      string
		want    Money
		wantErr bool
	}{
		{
			name:  "add same currency",
			left:  New(100, "DZD"),
			right: New(250, "DZD"),
			op:    "add",
			want:  New(350, "DZD"),
		},
		{
			name:    "add mixed currencies errors",
			left:    New(100, "DZD"),
			right:   New(250, "EUR"),
			op:      "add",
			wantErr: true,
		},
		{
			name:  "sub same currency",
			left:  New(100, "DZD"),
			right: New(250, "DZD"),
			op:    "sub",
			want:  New(-150, "DZD"),
		},
		{
			name:    "sub mixed currencies errors",
			left:    New(100, "DZD"),
			right:   New(250, "EUR"),
			op:      "sub",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var (
				got Money
				err error
			)

			switch tt.op {
			case "add":
				got, err = tt.left.Add(tt.right)
			case "sub":
				got, err = tt.left.Sub(tt.right)
			default:
				t.Fatalf("unknown operation %q", tt.op)
			}

			if (err != nil) != tt.wantErr {
				t.Fatalf("%s error = %v, wantErr %v", tt.op, err, tt.wantErr)
			}
			if !tt.wantErr && got != tt.want {
				t.Fatalf("%s result = %+v, want %+v", tt.op, got, tt.want)
			}
		})
	}
}

func TestMul(t *testing.T) {
	tests := []struct {
		name string
		m    Money
		qty  int64
		want Money
	}{
		{name: "positive quantity", m: New(123, "DZD"), qty: 3, want: New(369, "DZD")},
		{name: "zero quantity", m: New(123, "DZD"), qty: 0, want: New(0, "DZD")},
		{name: "negative quantity", m: New(123, "DZD"), qty: -2, want: New(-246, "DZD")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.m.Mul(tt.qty); got != tt.want {
				t.Fatalf("Mul(%d) = %+v, want %+v", tt.qty, got, tt.want)
			}
		})
	}
}

func TestAllocate(t *testing.T) {
	tests := []struct {
		name    string
		m       Money
		ratios  []int
		want    []Money
		wantErr bool
	}{
		{
			name:   "100 split equally distributes remainder to first parts",
			m:      New(100, "DZD"),
			ratios: []int{1, 1, 1},
			want:   []Money{New(34, "DZD"), New(33, "DZD"), New(33, "DZD")},
		},
		{
			name:   "100 split by 3 to 1",
			m:      New(100, "DZD"),
			ratios: []int{3, 1},
			want:   []Money{New(75, "DZD"), New(25, "DZD")},
		},
		{
			name:   "single ratio gets all amount",
			m:      New(987, "EUR"),
			ratios: []int{7},
			want:   []Money{New(987, "EUR")},
		},
		{
			name:   "negative amount preserves total and assigns negative remainder to first parts",
			m:      New(-100, "DZD"),
			ratios: []int{1, 1, 1},
			want:   []Money{New(-34, "DZD"), New(-33, "DZD"), New(-33, "DZD")},
		},
		{
			name:   "remainder is zero",
			m:      New(120, "DZD"),
			ratios: []int{1, 2, 3},
			want:   []Money{New(20, "DZD"), New(40, "DZD"), New(60, "DZD")},
		},
		{
			name:    "empty ratios errors",
			m:       New(100, "DZD"),
			ratios:  []int{},
			wantErr: true,
		},
		{
			name:    "zero ratio sum errors",
			m:       New(100, "DZD"),
			ratios:  []int{1, -1},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := tt.m.Allocate(tt.ratios)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Allocate(%+v, %v) error = %v, wantErr %v", tt.m, tt.ratios, err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("Allocate(%+v, %v) = %+v, want %+v", tt.m, tt.ratios, got, tt.want)
			}
			if sum := mustSumParts(t, got, tt.m.Currency); sum != tt.m {
				t.Fatalf("sum(parts) = %+v, want original %+v", sum, tt.m)
			}
		})
	}
}

func TestAllocateSumProperty(t *testing.T) {
	tests := []struct {
		name   string
		m      Money
		ratios []int
	}{
		{name: "positive amount remainder", m: New(101, "DZD"), ratios: []int{1, 1, 1}},
		{name: "negative amount remainder", m: New(-101, "DZD"), ratios: []int{1, 1, 1}},
		{name: "positive uneven ratios", m: New(999, "EUR"), ratios: []int{5, 3, 2}},
		{name: "negative uneven ratios", m: New(-999, "EUR"), ratios: []int{5, 3, 2}},
		{name: "zero amount", m: New(0, "DZD"), ratios: []int{2, 3, 5}},
		{name: "larger positive amount", m: New(123456789, "EUR"), ratios: []int{7, 11, 13, 17}},
		{name: "larger negative amount", m: New(-123456789, "EUR"), ratios: []int{7, 11, 13, 17}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			parts, err := tt.m.Allocate(tt.ratios)
			if err != nil {
				t.Fatalf("Allocate(%+v, %v) unexpected error: %v", tt.m, tt.ratios, err)
			}
			if sum := mustSumParts(t, parts, tt.m.Currency); sum != tt.m {
				t.Fatalf("sum(parts) = %+v, want original %+v; parts=%+v", sum, tt.m, parts)
			}
		})
	}
}

func TestString(t *testing.T) {
	tests := []struct {
		name string
		m    Money
		want string
	}{
		{name: "positive", m: New(123456, "DZD"), want: "1234.56 DZD"},
		{name: "negative", m: New(-1200, "EUR"), want: "-12.00 EUR"},
		{name: "one cent", m: New(1, "DZD"), want: "0.01 DZD"},
		{name: "zero", m: New(0, "EUR"), want: "0.00 EUR"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.m.String(); got != tt.want {
				t.Fatalf("String() = %q, want %q", got, tt.want)
			}
		})
	}
}
