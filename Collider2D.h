#ifndef	COLLIDER_2D_H
#define COLLIDER_2D_H

#include "./Bin/Include/glad/glad.h"
#include "./Bin/Include/GLFW/glfw3.h"
#include <iostream>
#include <string>
#include "Component.h"

class Collider2D : public Component {
public:
	float friction;
	bool isTrigger;

	Collider2D(const std::string& _name) : Component(_name) {
		friction = 0.0f;
		isTrigger = false;
	}
};

#endif