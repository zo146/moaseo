const express = require('express');
const router = express.Router();
const db = require('./db'); 

// [수정] 리뷰 등록 라우터
router.post('/reviews', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    const { product_id, rating, content } = req.body;
    const user_id = req.session.user.id; 

    try {
        // 윤섭님 테이블 구조에 맞춰 user_name을 빼고, helpful을 추가(기본값 0)했습니다.
        const sql = `
            INSERT INTO reviews (product_id, user_id, rating, content, helpful) 
            VALUES (?, ?, ?, ?, 0)
        `;
        await db.query(sql, [product_id, user_id, rating, content]);
        res.status(201).json({ success: true });
    } catch (error) {
        console.error("POST /reviews ERROR:", error);
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'ALREADY_REVIEWED' });
        }
        res.status(500).json({ error: error.message });
    }
});

// [수정] 리뷰 목록 및 평점 조회 라우터
router.get('/reviews/:product_id', async (req, res) => {
    const { product_id } = req.params;

    try {
        // JOIN을 사용하여 users 테이블에서 작성자 이름을 가져오도록 수정했습니다.
        const listSql = `
            SELECT r.*, u.username as user_name 
            FROM reviews r
            JOIN users u ON r.user_id = u.id
            WHERE r.product_id = ? 
            ORDER BY r.created_at DESC
        `;
        const [reviews] = await db.query(listSql, [product_id]);

        const avgSql = `
            SELECT IFNULL(AVG(rating), 0) as avgRating, COUNT(*) as reviewCount 
            FROM reviews 
            WHERE product_id = ?
        `;
        const [stats] = await db.query(avgSql, [product_id]);

        res.json({
            reviews: reviews || [],
            avgRating: stats[0] && stats[0].avgRating ? parseFloat(stats[0].avgRating).toFixed(1) : "0.0",
            reviewCount: stats[0] && stats[0].reviewCount ? stats[0].reviewCount : 0
        });
    } catch (error) {
        console.error("GET /reviews ERROR:", error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;