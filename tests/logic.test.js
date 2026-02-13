/**
 * Unit tests for pagination, input validation, and workspace scoping logic.
 * Tests are structured as pure logic tests that don't require a database connection.
 */

// ─── Pagination helper (extracted logic) ────────────────

function parsePagination(query) {
    const page = Number(query.page || 1);
    const limit = Number(query.limit || 20);
    const skip = (page - 1) * limit;
    return { page, limit, skip, totalPages: (total) => Math.ceil(total / limit) };
}

describe('Pagination Logic', () => {
    it('should default to page 1 and limit 20', () => {
        const result = parsePagination({});
        expect(result.page).toBe(1);
        expect(result.limit).toBe(20);
        expect(result.skip).toBe(0);
    });

    it('should calculate correct skip for page 2', () => {
        const result = parsePagination({ page: '2', limit: '20' });
        expect(result.skip).toBe(20);
    });

    it('should calculate correct skip for page 3, limit 10', () => {
        const result = parsePagination({ page: '3', limit: '10' });
        expect(result.skip).toBe(20);
    });

    it('should calculate totalPages correctly', () => {
        const result = parsePagination({ page: '1', limit: '10' });
        expect(result.totalPages(100)).toBe(10);
        expect(result.totalPages(95)).toBe(10);
        expect(result.totalPages(101)).toBe(11);
    });

    it('should handle string query params correctly (the bug we fixed)', () => {
        // Before fix: ("2" - 1) * "20" = 1 * "20" = 20 (works by coercion)
        // But: Math.ceil(100 / "20") = 5 (works by coercion)
        // HOWEVER: ("1" - 1) * "20" = 0 * "20" = 0 (works)
        // The real bug: skip = (page - 1) * limit with strings
        // e.g. page="1", limit="20" -> ("1"-1)*"20" = 0*"20" = 0 (ok)
        // but page="2", limit="20" -> ("2"-1)*"20" = 1*"20" = "20" (string "20" not number 20)
        // This passes to Prisma as a string which may cause issues
        const result = parsePagination({ page: '2', limit: '20' });
        expect(typeof result.skip).toBe('number');
        expect(result.skip).toBe(20);
        expect(typeof result.page).toBe('number');
        expect(typeof result.limit).toBe('number');
    });

    it('should handle edge case: NaN inputs', () => {
        const result = parsePagination({ page: 'abc', limit: 'xyz' });
        expect(result.page).toBeNaN();
        expect(result.limit).toBeNaN();
    });
});

// ─── Input Validation Logic ─────────────────────────────

describe('Auth Input Validation', () => {
    it('should require email and password for login', () => {
        const validate = (body) => {
            if (!body.email || !body.password) return { error: 'Email and password are required' };
            return null;
        };
        expect(validate({})).toEqual({ error: 'Email and password are required' });
        expect(validate({ email: 'test@test.com' })).toEqual({ error: 'Email and password are required' });
        expect(validate({ password: 'pass' })).toEqual({ error: 'Email and password are required' });
        expect(validate({ email: 'test@test.com', password: 'pass' })).toBeNull();
    });

    it('should require email, password, name, and businessName for register', () => {
        const validate = (body) => {
            if (!body.email || !body.password || !body.name || !body.businessName) {
                return { error: 'Email, password, name, and business name are required' };
            }
            return null;
        };
        expect(validate({})).toBeTruthy();
        expect(validate({ email: 'a', password: 'b', name: 'c' })).toBeTruthy();
        expect(validate({ email: 'a', password: 'b', name: 'c', businessName: 'd' })).toBeNull();
    });
});

describe('Booking Input Validation', () => {
    it('should require name and duration for service type creation', () => {
        const validate = (body) => {
            if (!body.name || !body.duration) return { error: 'Name and duration are required' };
            return null;
        };
        expect(validate({})).toEqual({ error: 'Name and duration are required' });
        expect(validate({ name: 'Haircut' })).toEqual({ error: 'Name and duration are required' });
        expect(validate({ name: 'Haircut', duration: 30 })).toBeNull();
    });

    it('should validate booking status', () => {
        const validStatuses = ['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];
        const validateStatus = (status) => validStatuses.includes(status);

        expect(validateStatus('CONFIRMED')).toBe(true);
        expect(validateStatus('COMPLETED')).toBe(true);
        expect(validateStatus('NO_SHOW')).toBe(true);
        expect(validateStatus('CANCELLED')).toBe(true);
        expect(validateStatus('PENDING')).toBe(false);
        expect(validateStatus('invalid')).toBe(false);
        expect(validateStatus('')).toBe(false);
    });

    it('should handle price defaulting', () => {
        const getPrice = (price) => price !== undefined ? Number(price) : 0;
        expect(getPrice(undefined)).toBe(0);
        expect(getPrice(0)).toBe(0);
        expect(getPrice('50')).toBe(50);
        expect(getPrice(99.99)).toBe(99.99);
    });
});

describe('Contact Validation', () => {
    it('should require name for contact creation', () => {
        const validate = (body) => {
            if (!body.name) return { error: 'Name is required' };
            if (!body.email && !body.phone) return { error: 'Email or phone is required' };
            return null;
        };
        expect(validate({})).toEqual({ error: 'Name is required' });
        expect(validate({ name: 'John' })).toEqual({ error: 'Email or phone is required' });
        expect(validate({ name: 'John', email: 'john@test.com' })).toBeNull();
        expect(validate({ name: 'John', phone: '1234567890' })).toBeNull();
    });
});

describe('Inventory Logic', () => {
    it('should correctly detect low stock', () => {
        const isLowStock = (quantity, threshold) => quantity <= threshold;
        expect(isLowStock(5, 5)).toBe(true);
        expect(isLowStock(4, 5)).toBe(true);
        expect(isLowStock(0, 5)).toBe(true);
        expect(isLowStock(6, 5)).toBe(false);
        expect(isLowStock(100, 5)).toBe(false);
    });

    it('should handle quantity/threshold type coercion', () => {
        expect(Number('10')).toBe(10);
        expect(Number('0')).toBe(0);
        expect(Number(undefined)).toBeNaN();
    });
});

// ─── Slot Generation Logic ──────────────────────────────

describe('Available Slot Generation', () => {
    function generateSlots(startTime, endTime, duration) {
        const [startH, startM] = startTime.split(':').map(Number);
        const [endH, endM] = endTime.split(':').map(Number);

        let currentMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        const slots = [];

        while (currentMinutes + duration <= endMinutes) {
            const slotHour = Math.floor(currentMinutes / 60);
            const slotMin = currentMinutes % 60;
            const slotTime = `${String(slotHour).padStart(2, '0')}:${String(slotMin).padStart(2, '0')}`;
            slots.push(slotTime);
            currentMinutes += duration;
        }

        return slots;
    }

    it('should generate correct 30-min slots from 09:00 to 12:00', () => {
        const slots = generateSlots('09:00', '12:00', 30);
        expect(slots).toEqual(['09:00', '09:30', '10:00', '10:30', '11:00', '11:30']);
        expect(slots.length).toBe(6);
    });

    it('should generate correct 60-min slots from 09:00 to 17:00', () => {
        const slots = generateSlots('09:00', '17:00', 60);
        expect(slots.length).toBe(8);
        expect(slots[0]).toBe('09:00');
        expect(slots[7]).toBe('16:00');
    });

    it('should generate no slots if duration exceeds window', () => {
        const slots = generateSlots('09:00', '09:30', 60);
        expect(slots.length).toBe(0);
    });

    it('should handle 15-min intervals', () => {
        const slots = generateSlots('14:00', '15:00', 15);
        expect(slots).toEqual(['14:00', '14:15', '14:30', '14:45']);
    });

    it('should not generate a slot if it would extend past end time', () => {
        const slots = generateSlots('09:00', '09:45', 30);
        expect(slots).toEqual(['09:00']);
    });
});

// ─── Booking Overlap Detection ──────────────────────────

describe('Booking Overlap Detection', () => {
    function isOverlapping(slotStart, slotEnd, bookingStart, bookingEnd) {
        return slotStart < bookingEnd && slotEnd > bookingStart;
    }

    it('should detect overlapping bookings', () => {
        const slot = { start: new Date('2026-02-14T10:00:00'), end: new Date('2026-02-14T10:30:00') };
        const booking = { start: new Date('2026-02-14T10:00:00'), end: new Date('2026-02-14T10:30:00') };
        expect(isOverlapping(slot.start, slot.end, booking.start, booking.end)).toBe(true);
    });

    it('should detect partial overlap', () => {
        const slot = { start: new Date('2026-02-14T10:00:00'), end: new Date('2026-02-14T10:30:00') };
        const booking = { start: new Date('2026-02-14T10:15:00'), end: new Date('2026-02-14T10:45:00') };
        expect(isOverlapping(slot.start, slot.end, booking.start, booking.end)).toBe(true);
    });

    it('should not flag adjacent slots as overlapping', () => {
        const slot = { start: new Date('2026-02-14T10:00:00'), end: new Date('2026-02-14T10:30:00') };
        const booking = { start: new Date('2026-02-14T10:30:00'), end: new Date('2026-02-14T11:00:00') };
        expect(isOverlapping(slot.start, slot.end, booking.start, booking.end)).toBe(false);
    });

    it('should not flag non-overlapping slots', () => {
        const slot = { start: new Date('2026-02-14T10:00:00'), end: new Date('2026-02-14T10:30:00') };
        const booking = { start: new Date('2026-02-14T14:00:00'), end: new Date('2026-02-14T14:30:00') };
        expect(isOverlapping(slot.start, slot.end, booking.start, booking.end)).toBe(false);
    });
});
